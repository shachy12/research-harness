import { type Attachment, type DagNode, type ForkProposal, type NodeDetail, type NodeSummary, formatElapsed, toolActivity } from '@harness/shared'
import { PencilIcon } from 'lucide-react'
import { Fragment, useEffect, useEffectEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useGraph, useNodeDetail, useRetry } from '@/api/queries'
import { MergeChip, StatusChip } from '@/components/StatusChip'
import { UsageBanner } from '@/components/UsageBanner'
import { activityOf } from '@/lib/activity'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChangesPanel } from '@/features/editing/ChangesPanel'
import { ForkDialog } from '@/features/fork/ForkDialog'
import { ProposalBox } from '@/features/fork/ProposalBox'
import { NodeModelPicker } from '@/features/model/NodeModelPicker'
import { RenameDialog } from '@/features/rename/RenameDialog'
import { ResultBlock } from '@/features/result/ResultBlock'
import { ResultDialog } from '@/features/result/ResultDialog'
import { describeReset, limitName } from '@/lib/limit'
import { itemTitle, resolveSelection } from '@/lib/listItems'
import { contextTokens, estimateTokens } from '@/lib/tokens'
import { useDropZone } from '@/lib/useDropZone'
import { useNow } from '@/lib/useNow'
import { AskApprovalBox } from './AskApprovalBox'
import { AttachMenu } from './AttachMenu'
import { PendingAttachments } from './AttachmentChip'
import { InheritedContext } from './InheritedContext'
import { useAttachments } from './useAttachments'
import { ListSelectionContext, useListSelection, useListSelectionState } from './listSelection'
import { SelectionBar } from './SelectionBar'
import { useChatScroll } from './useChatScroll'
import { MessageView } from './MessageView'
import { type StreamError, useChatStream } from './useChatStream'

/** One component instance per node, so streaming state never leaks between nodes. */
export function ChatPage() {
  const { projectId, nodeId } = useParams()
  return <ChatView key={nodeId} projectId={projectId!} nodeId={nodeId!} />
}

/**
 * 'fork-selection' is the fork dialog started from the list items ticked in the replies;
 * a ForkProposal opens it with the branches the model proposed.
 */
type DialogKind = 'fork' | 'fork-selection' | ForkProposal | 'result' | 'rename' | null

function ChatView({ projectId, nodeId }: { projectId: string; nodeId: string }) {
  const detail = useNodeDetail(nodeId)
  const graph = useGraph(projectId)
  const navigate = useNavigate()
  const graphUrl = `/projects/${projectId}`
  const [dialog, setDialog] = useState<DialogKind>(null)
  const selection = useListSelectionState()
  const hasSelection = selection.items.length > 0

  // Esc clears ticked list items first, then returns to the graph (dialogs handle their own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || dialog || e.defaultPrevented) return
      if (hasSelection) selection.clear()
      else navigate(graphUrl)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selection` is rebuilt every render; only its clearing matters
  }, [navigate, graphUrl, dialog, hasSelection])

  if (detail.isError) {
    return (
      <div className="grid h-full place-items-center p-4 text-sm">
        <div className="flex flex-col items-center gap-3">
          <p className="text-destructive">Could not load this node: {detail.error.message}</p>
          <Button variant="outline" nativeButton={false} render={<Link to={graphUrl} />}>← Back to the graph</Button>
        </div>
      </div>
    )
  }
  // Wait for the fresh copy that opening the chat fetches: the opening scroll position depends on
  // what has been read, and a copy cached from an earlier visit may be out of date. Only while that
  // fetch is actually running, though: if none is (it was skipped or dropped), use what we have
  // rather than wait forever.
  const waitingForFresh = !detail.isFetchedAfterMount && detail.isFetching
  if (!detail.data || waitingForFresh) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const { node } = detail.data
  // Everything the node's next prompt contains: what it inherits plus its own messages.
  const historyTokens = contextTokens(detail.data.inherited) + detail.data.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to={graphUrl} />}>
          ← Graph
        </Button>
        <Breadcrumb node={node} nodes={graph.data?.nodes ?? []} projectId={projectId} />
      </div>

      <ListSelectionContext value={selection}>
        <Conversation key={node.id} detail={detail.data} onDialog={setDialog} />
      </ListSelectionContext>

      {dialog !== null && dialog !== 'result' && dialog !== 'rename' && (
        <ForkDialog
          node={node}
          inheritedTokens={historyTokens}
          existingBranches={detail.data.childIds.length}
          items={
            dialog === 'fork-selection'
              ? resolveSelection(selection.items, detail.data.messages.map((m) => m.id)).map((i) => ({
                  text: i.text,
                  title: i.title ?? itemTitle(i.text),
                }))
              : undefined
          }
          proposal={typeof dialog === 'object' ? dialog : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'result' && <ResultDialog node={node} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameDialog node={node} onClose={() => setDialog(null)} />}
    </div>
  )
}

function Conversation({ detail, onDialog }: { detail: NodeDetail; onDialog: (d: DialogKind) => void }) {
  const { node, messages, inherited, childIds } = detail
  const selection = useListSelection()
  const picked = selection ? resolveSelection(selection.items, messages.map((m) => m.id)) : []
  const stream = useChatStream(node.id)
  const files = useAttachments(node.projectId)
  const retry = useRetry()
  const [draft, setDraft] = useState('')
  const canWrite = node.status === 'open'
  // Drop files and folders anywhere on the chat to attach them to the next message.
  const drop = useDropZone(files.addPicked, canWrite)

  // The streamed copies are shown until the refetched saved messages replace them, so nothing appears twice.
  const [sentFiles, setSentFiles] = useState<Attachment[]>([])
  const { scrollRef, endRef, onScroll, followNext } = useChatScroll({
    nodeId: node.id,
    messages,
    readUpto: node.readUpto,
    contentKey: [messages.length, stream.replyText, stream.userText, stream.toolCalls.length],
  })
  const send = (text: string, attachments: Attachment[] = []) => {
    followNext() // your own message always jumps to the bottom
    setSentFiles(attachments)
    void stream.send(text, attachments, messages.length)
  }
  const showStreamed = stream.active && messages.length === stream.baseline

  // Progress while working: what the model is doing right now, and for how long.
  const working = stream.active || detail.running
  const now = useNow(working)
  const startedAt = stream.startedAt ?? detail.run?.startedAt
  const elapsed = working && startedAt ? formatElapsed(now - Date.parse(startedAt)) : undefined
  const runningTool = stream.toolCalls.findLast((c) => c.status === 'running')
  const currentActivity = stream.approval
    ? 'Waiting for your approval'
    : runningTool
    ? toolActivity(runningTool)
    : stream.thinking || stream.toolCalls.length > 0
      ? 'Thinking'
      : 'Starting Claude'

  // The node may already be working (a branch started by fork, a merge, or a reply sent from
  // another page): watch it while it runs. The cleanup stops watching, so React's double mount in
  // development (and leaving the page) can't leave a dead watch behind. Not while sending: the
  // send already streams the reply.
  const startWatching = useEffectEvent(() => {
    if (stream.userText !== null) return undefined
    return stream.attach(messages.length)
  })
  useEffect(() => {
    if (!detail.running) return
    return startWatching()
  }, [detail.running])

  const submit = () => {
    const text = draft.trim()
    if (!text || stream.active || files.uploading) return
    setDraft('')
    send(text, files.ready)
    files.clear()
  }

  const hasReply = messages.some((m) => m.role === 'assistant')
  const canFinish = node.status === 'open' && node.parentIds.length > 0
  // The last message is yours and nothing is answering it: the reply failed or was stopped early.
  const unanswered = canWrite && !working && messages.at(-1)?.role === 'user'
  const limitReached = detail.usage?.status === 'reached'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.props}>
      {drop.dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
          Drop files or folders to attach them to your next message
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-balance">
              {node.title}
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-1 align-middle text-muted-foreground"
                aria-label="Rename"
                title="Rename"
                onClick={() => onDialog('rename')}
              >
                <PencilIcon />
              </Button>
            </h1>
            <StatusChip
              status={node.status}
              activity={activityOf(node.status, working, messages.at(-1)?.role ?? null, limitReached)}
              elapsed={elapsed}
            />
            {node.parentIds.length > 1 && <MergeChip />}
          </div>

          <UsageBanner usage={detail.usage} />

          <InheritedContext items={inherited} />

          {messages.length === 0 && !stream.active && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {inherited.length
                ? 'This node already has the context above. Ask its question to start.'
                : 'Start the research: describe what you want to find out.'}
            </p>
          )}

          {messages.map((m) => (
            <Fragment key={m.id}>
              <MessageView id={m.id} role={m.role} text={m.content} toolCalls={m.toolCalls} attachments={m.attachments} />
              {m.forkProposal && canWrite && (
                <ProposalBox proposal={m.forkProposal} disabled={working} onReview={() => onDialog(m.forkProposal)} />
              )}
            </Fragment>
          ))}
          {showStreamed && stream.userText && <MessageView role="user" text={stream.userText} attachments={sentFiles} />}
          {showStreamed && (stream.replyText || stream.toolCalls.length > 0) && (
            <MessageView role="assistant" text={stream.replyText} toolCalls={stream.toolCalls} streaming />
          )}
          {showStreamed && !stream.replyText && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-open" aria-hidden="true" />
              <span className="min-w-0 truncate">{currentActivity}…</span>
              {elapsed && <span className="shrink-0">· {elapsed}</span>}
            </p>
          )}
          {showStreamed && stream.approval && <AskApprovalBox nodeId={node.id} approval={stream.approval} />}
          {unanswered ? (
            <NoReply
              error={stream.error}
              limit={limitReached ? detail.usage : null}
              retrying={retry.isPending}
              retryError={retry.error?.message}
              onRetry={() => {
                stream.clearError()
                retry.mutate(node.id)
              }}
            />
          ) : (
            stream.error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{stream.error.message}</p>
            )
          )}

          <ChangesPanel node={node} version={`${node.filesChanged}-${messages.length}`} working={working} />
          {node.result && <ResultBlock result={node.result} onEdit={() => onDialog('result')} />}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3">
          <SelectionBar
            picked={picked}
            ticked={selection?.items.length ?? 0}
            disabled={stream.active}
            onFork={() => onDialog('fork-selection')}
            onClear={() => selection?.clear()}
          />
          {canWrite ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <PendingAttachments files={files.files} onRemove={files.remove} />
              <div className="flex items-end gap-2">
              <AttachMenu onFiles={files.addFiles} onFolders={files.addFolders} />
              <Textarea
                aria-label="Message"
                rows={2}
                placeholder="Message this node… (Enter to send, Shift+Enter for a new line)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit()
                  }
                }}
                className="max-h-48 min-h-11 resize-none"
              />
              {stream.active ? (
                <Button type="button" variant="outline" onClick={stream.stop}>Stop</Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!draft.trim() || files.uploading}
                  title={files.uploading ? 'Waiting for uploads to finish' : undefined}
                >
                  Send
                </Button>
              )}
              </div>
            </form>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              {node.status === 'frozen' ? (
                <>
                  Forked, so this node is frozen. Continue in a branch:{' '}
                  <ChildLinks projectId={node.projectId} childIds={childIds} />
                </>
              ) : (
                'Finished. Right-click it in the graph to include its result in a merge.'
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={stream.active} onClick={() => onDialog('fork')}>
              ⑂ Fork
            </Button>
            {canFinish && (
              <Button variant="outline" size="sm" disabled={!hasReply || stream.active} onClick={() => onDialog('result')}>
                ✓ Finish branch
              </Button>
            )}
            {canWrite && (
              <NodeModelPicker
                node={node}
                replyCount={messages.filter((m) => m.role === 'assistant').length}
                historyTokens={contextTokens(inherited) + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)}
                lastReplyModel={messages.findLast((m) => m.role === 'assistant')?.model ?? null}
                disabled={working}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The last message got no reply: say why (when known) and offer to send it again. */
function NoReply({ error, limit, retrying, retryError, onRetry }: {
  error: StreamError | null
  limit: NodeDetail['usage']
  retrying: boolean
  retryError?: string
  onRetry: () => void
}) {
  const now = useNow(true, 30_000)
  const resetsAt = error?.resetsAt ?? limit?.resetsAt
  const message =
    error?.kind === 'usage_limit' || (!error && limit)
      ? `Claude ${limit ? limitName(limit) : 'usage limit'} reached${resetsAt ? `: it resets at ${describeReset(resetsAt, now)}` : ''}. Retry once it has reset.`
      : (error?.message ?? 'No reply: it failed or was stopped before writing anything.')

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span className="min-w-0 flex-1">{message}</span>
      <Button size="sm" variant="outline" className="bg-background text-foreground" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
      {retryError && <span className="basis-full">{retryError}</span>}
    </div>
  )
}

function ChildLinks({ projectId, childIds }: { projectId: string; childIds: string[] }) {
  const graph = useGraph(projectId)
  const titles = new Map(graph.data?.nodes.map((n) => [n.id, n.title]))
  return childIds.map((id, i) => (
    <Fragment key={id}>
      {i > 0 && ', '}
      <Link className="text-primary underline underline-offset-2" to={`/projects/${projectId}/nodes/${id}`}>
        {titles.get(id) ?? 'branch'}
      </Link>
    </Fragment>
  ))
}

/** Ancestors through first parents; a merge node shows its merged branches instead. */
function Breadcrumb({ node, nodes, projectId }: { node: DagNode; nodes: NodeSummary[]; projectId: string }) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const path: DagNode[] = []
  let current: DagNode | undefined = node
  while (current) {
    path.unshift(current)
    current = current.parentIds.length === 1 ? byId.get(current.parentIds[0]) : undefined
  }
  const top = path[0]
  const link = (n: DagNode) => (
    <Link className="text-primary hover:underline" to={`/projects/${projectId}/nodes/${n.id}`}>{n.title}</Link>
  )

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {top.parentIds.length > 1 && (
        <>
          {top.parentIds.map((id, i) => {
            const p = byId.get(id)
            return p ? <Fragment key={id}>{i > 0 && ' + '}{link(p)}</Fragment> : null
          })}
          <span>→</span>
        </>
      )}
      {path.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && <span>›</span>}
          {i === path.length - 1 ? <span className="text-foreground">{n.title}</span> : link(n)}
        </Fragment>
      ))}
    </nav>
  )
}
