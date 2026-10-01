import type { DagNode, NodeDetail, NodeSummary } from '@harness/shared'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useGraph, useNodeDetail } from '@/api/queries'
import { MergeChip, StatusChip } from '@/components/StatusChip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ForkDialog } from '@/features/fork/ForkDialog'
import { ResultBlock } from '@/features/result/ResultBlock'
import { ResultDialog } from '@/features/result/ResultDialog'
import { contextTokens } from '@/lib/tokens'
import { InheritedContext } from './InheritedContext'
import { MessageView } from './MessageView'
import { useChatStream } from './useChatStream'

/** One component instance per node, so streaming state never leaks between nodes. */
export function ChatPage() {
  const { projectId, nodeId } = useParams()
  return <ChatView key={nodeId} projectId={projectId!} nodeId={nodeId!} />
}

type DialogKind = 'fork' | 'result' | null

function ChatView({ projectId, nodeId }: { projectId: string; nodeId: string }) {
  const detail = useNodeDetail(nodeId)
  const graph = useGraph(projectId)
  const navigate = useNavigate()
  const graphUrl = `/projects/${projectId}`
  const [dialog, setDialog] = useState<DialogKind>(null)

  // Esc returns to the graph (dialogs handle their own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dialog && !e.defaultPrevented) navigate(graphUrl)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, graphUrl, dialog])

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
  if (!detail.data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const { node } = detail.data
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to={graphUrl} />}>
          ← Graph
        </Button>
        <Breadcrumb node={node} nodes={graph.data?.nodes ?? []} projectId={projectId} />
      </div>

      <Conversation key={node.id} detail={detail.data} onDialog={setDialog} />

      {dialog === 'fork' && (
        <ForkDialog
          node={node}
          inheritedTokens={contextTokens(detail.data.inherited) + detail.data.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'result' && <ResultDialog node={node} onClose={() => setDialog(null)} />}
    </div>
  )
}

function Conversation({ detail, onDialog }: { detail: NodeDetail; onDialog: (d: DialogKind) => void }) {
  const { node, messages, inherited, childIds } = detail
  const stream = useChatStream(node.id)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const navigate = useNavigate()

  // How many saved messages there were when the current message was sent. The streamed copies are
  // shown until the saved messages (refetched after the reply) replace them, so nothing appears twice.
  const [sentAt, setSentAt] = useState(-1)
  const send = (text: string) => {
    setSentAt(messages.length)
    void stream.send(text)
  }
  const showStreamed = stream.active && messages.length === sentAt

  // A merged node is created with its first message passed along from the merge dialog. Send it once.
  const autoSent = useRef(false)
  const autoSend = (location.state as { autoSend?: string } | null)?.autoSend
  useEffect(() => {
    if (!autoSend || autoSent.current || messages.length > 0 || node.status !== 'open') return
    autoSent.current = true
    navigate(location.pathname, { replace: true, state: null })
    send(autoSend)
  })

  // Keep the newest content in view.
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, stream.replyText, stream.userText])

  const submit = () => {
    const text = draft.trim()
    if (!text || stream.active) return
    setDraft('')
    send(text)
  }

  const hasReply = messages.some((m) => m.role === 'assistant')
  const canFinish = node.status === 'open' && node.parentIds.length > 0

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-balance">{node.title}</h1>
            <StatusChip status={node.status} />
            {node.parentIds.length > 1 && <MergeChip />}
          </div>

          <InheritedContext items={inherited} />

          {messages.length === 0 && !stream.active && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {inherited.length
                ? 'This node already has the context above. Ask its question to start.'
                : 'Start the research: describe what you want to find out.'}
            </p>
          )}

          {messages.map((m) => (
            <MessageView key={m.id} role={m.role} text={m.content} />
          ))}
          {showStreamed && stream.userText && <MessageView role="user" text={stream.userText} />}
          {showStreamed && stream.replyText && <MessageView role="assistant" text={stream.replyText} streaming />}
          {showStreamed && !stream.replyText && (
            <p className="animate-pulse text-sm text-muted-foreground">{stream.thinking ? 'Thinking…' : 'Waiting for the model…'}</p>
          )}
          {stream.error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{stream.error}</p>}

          {node.result && <ResultBlock result={node.result} onEdit={() => onDialog('result')} />}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3">
          {node.status === 'open' ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
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
                <Button type="submit" disabled={!draft.trim()}>Send</Button>
              )}
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
          </div>
        </div>
      </div>
    </>
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
