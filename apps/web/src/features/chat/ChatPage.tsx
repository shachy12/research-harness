import type { Attachment, DagNode, NodeDetail, NodeSummary } from '@harness/shared'
import { FolderIcon, PaperclipIcon } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useGraph, useNodeDetail } from '@/api/queries'
import { MergeChip, StatusChip } from '@/components/StatusChip'
import { activityOf } from '@/lib/activity'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ForkDialog } from '@/features/fork/ForkDialog'
import { ResultBlock } from '@/features/result/ResultBlock'
import { ResultDialog } from '@/features/result/ResultDialog'
import { groupPickedFolder, readDrop } from '@/lib/dropped-files'
import { contextTokens } from '@/lib/tokens'
import { AttachmentChip } from './AttachmentChip'
import { InheritedContext } from './InheritedContext'
import { useAttachments } from './useAttachments'
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
  const files = useAttachments(node.projectId)
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const canWrite = node.status === 'open'

  // How many saved messages there were when the current reply started. The streamed copies are
  // shown until the saved messages (refetched after the reply) replace them, so nothing appears twice.
  const [sentAt, setSentAt] = useState(-1)
  const [sentFiles, setSentFiles] = useState<Attachment[]>([])
  const send = (text: string, attachments: Attachment[] = []) => {
    setSentAt(messages.length)
    setSentFiles(attachments)
    void stream.send(text, attachments)
  }
  const showStreamed = stream.active && messages.length === sentAt

  // The node may already be working (a branch started by fork, a merge, or a reply sent earlier):
  // attach to it once when the page opens.
  const attached = useRef(false)
  const { watch } = stream
  useEffect(() => {
    if (!detail.running || attached.current) return
    attached.current = true
    setSentAt(messages.length)
    void watch()
  }, [detail.running, messages.length, watch])

  // Keep the newest content in view.
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, stream.replyText, stream.userText, stream.toolCalls.length])

  const submit = () => {
    const text = draft.trim()
    if (!text || stream.active || files.uploading) return
    setDraft('')
    send(text, files.ready)
    files.clear()
  }

  const hasReply = messages.some((m) => m.role === 'assistant')
  const canFinish = node.status === 'open' && node.parentIds.length > 0

  // Drop files anywhere on the chat to attach them to the next message.
  const dropProps = canWrite
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(false)
          // Files and whole folders; readDrop must start during the event (the browser clears it after).
          void readDrop(e.dataTransfer).then((picked) => {
            if (picked.files.length) files.addFiles(picked.files)
            if (picked.folders.length) files.addFolders(picked.folders)
          })
        },
      }
    : {}

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...dropProps}>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
          Drop files or folders to attach them to your next message
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-balance">{node.title}</h1>
            <StatusChip
              status={node.status}
              activity={activityOf(node.status, stream.active || detail.running, messages.at(-1)?.role ?? null)}
            />
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
            <MessageView key={m.id} role={m.role} text={m.content} toolCalls={m.toolCalls} attachments={m.attachments} />
          ))}
          {showStreamed && stream.userText && <MessageView role="user" text={stream.userText} attachments={sentFiles} />}
          {showStreamed && (stream.replyText || stream.toolCalls.length > 0) && (
            <MessageView role="assistant" text={stream.replyText} toolCalls={stream.toolCalls} streaming />
          )}
          {showStreamed && !stream.replyText && (
            <p className="animate-pulse text-sm text-muted-foreground">
              {stream.toolCalls.some((c) => c.status === 'running')
                ? 'Researching…'
                : stream.thinking || stream.toolCalls.length > 0
                  ? 'Thinking…'
                  : 'Waiting for the model…'}
            </p>
          )}
          {stream.error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{stream.error}</p>}

          {node.result && <ResultBlock result={node.result} onEdit={() => onDialog('result')} />}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3">
          {canWrite ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              {files.files.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {files.files.map((f) => (
                    <AttachmentChip
                      key={f.key}
                      name={f.name}
                      size={f.size}
                      kind={f.kind}
                      fileCount={f.fileCount}
                      status={f.status}
                      error={f.error}
                      onRemove={() => files.remove(f.key)}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept=".pdf,.tex,.bib,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp"
                onChange={(e) => {
                  if (e.target.files?.length) files.addFiles(e.target.files)
                  e.target.value = '' // allow picking the same file again
                }}
              />
              <input
                ref={folderInput}
                type="file"
                hidden
                // Folder picker; React has no typed prop for this browser attribute.
                {...{ webkitdirectory: '' }}
                onChange={(e) => {
                  if (e.target.files?.length) files.addFolders(groupPickedFolder(e.target.files))
                  e.target.value = ''
                }}
              />
              <div className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Attach files"
                  title="Attach files (PDF, LaTeX, text, images) — or drop them on the chat"
                  onClick={() => fileInput.current?.click()}
                >
                  <PaperclipIcon />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Attach a folder"
                  title="Attach a folder (e.g. a LaTeX project) — or drop folders on the chat"
                  onClick={() => folderInput.current?.click()}
                >
                  <FolderIcon />
                </Button>
              </div>
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
          </div>
        </div>
      </div>
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
