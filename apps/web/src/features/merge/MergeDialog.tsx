import { type NodeDetail, type NodeSummary, defaultMergeTitle, lowestCommonAncestor } from '@harness/shared'
import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { keys, useMerge } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { contextTokens, estimateTokens, formatTokens, resultText } from '@/lib/tokens'
import { useMergeSelection } from './selection'

const DEFAULT_FRAMING = 'Synthesize these results into a recommendation and list what still needs research.'

/** Preview what the merged node will receive, then create it and open its chat. */
export function MergeDialog({ projectId, nodes, parentIds, onClose }: {
  projectId: string
  nodes: NodeSummary[]
  parentIds: string[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const merge = useMerge(projectId)
  const selection = useMergeSelection()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parents = parentIds.map((id) => byId.get(id)!).filter(Boolean)

  const baseId = lowestCommonAncestor((id) => byId.get(id)!, parentIds)
  const defaultTitle = defaultMergeTitle(parents.map((p) => p.title))
  const [title, setTitle] = useState(defaultTitle)
  const [framing, setFraming] = useState(DEFAULT_FRAMING)

  // Details of the base node (its full context) and of each branch (its transcript, to show what's saved).
  const details = useQueries({
    queries: [baseId, ...parentIds].filter(Boolean).map((id) => ({
      queryKey: keys.node(id!),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<NodeDetail>(`/nodes/${id}`, signal),
    })),
  })
  const base = baseId ? details[0]?.data : undefined
  const baseTokens = base
    ? contextTokens(base.inherited) + base.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
    : 0
  const resultTokens = parents.reduce((s, p) => s + (p.result ? estimateTokens(resultText(p.result)) : 0), 0)
  const transcriptTokens = details
    .slice(baseId ? 1 : 0)
    .reduce((s, d) => s + (d.data?.messages.reduce((t, m) => t + estimateTokens(m.content), 0) ?? 0), 0)

  const create = () =>
    merge.mutate(
      // An unchanged default title is left to the server, so a model-written title can replace it later.
      { parentIds, title: title.trim() && title.trim() !== defaultTitle ? title.trim() : undefined, prompt: framing.trim() },
      {
        onSuccess: (node) => {
          selection.clear()
          onClose()
          // The merged node is already working on its first message; its chat page attaches to it.
          navigate(`/projects/${projectId}/nodes/${node.id}`)
        },
      },
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge {parents.length} branches</DialogTitle>
          <DialogDescription>
            The new node starts with the base context plus each branch's result. Branch transcripts are left out.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg border text-sm">
          <div className="grid grid-cols-[88px_minmax(0,1fr)_auto] gap-3 px-3 py-2">
            <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Base</span>
            <span>{baseId ? byId.get(baseId)?.title : 'None'}</span>
            <span className="font-mono text-xs text-muted-foreground">~{formatTokens(baseTokens)} tok</span>
          </div>
          {parents.map((p) => (
            <div key={p.id} className="grid grid-cols-[88px_minmax(0,1fr)_auto] gap-3 border-t bg-done-soft px-3 py-2">
              <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">+ Result</span>
              <span className="min-w-0">
                <b>{p.title}</b>
                <span className="line-clamp-2 text-xs text-muted-foreground">{p.result?.findings}</span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                ~{formatTokens(p.result ? estimateTokens(resultText(p.result)) : 0)} tok
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          Results add ~{formatTokens(resultTokens)} tokens. The full branch transcripts would have added ~
          {formatTokens(transcriptTokens)}.
        </p>

        <div className="grid gap-1.5">
          <Label htmlFor="merge-title">Node title</Label>
          <Input id="merge-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          {title.trim() === defaultTitle && (
            <span className="text-xs text-muted-foreground">Keep this and a short title is written after the first reply.</span>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="merge-framing">First message</Label>
          <Textarea id="merge-framing" rows={3} value={framing} onChange={(e) => setFraming(e.target.value)} />
        </div>

        {merge.isError && <p className="text-sm text-destructive">{merge.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={merge.isPending || !framing.trim()}>
            {merge.isPending ? 'Creating…' : 'Create merged node'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
