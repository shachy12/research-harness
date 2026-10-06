import { type NodeSummary, defaultMergeTitle, mergeBaseOf, mergeModelSettings } from '@harness/shared'
import { useState } from 'react'
import { useMerge, useMergePreview, useModels, useNodeDetail } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ModelFields } from '@/features/model/ModelFields'
import { type ModelSettings, describeSettings } from '@/features/model/modelSettings'
import { contextTokens, estimateTokens, formatTokens } from '@/lib/tokens'
import { useMergeSelection } from './selection'

const DEFAULT_FRAMING = 'Synthesize these results into a recommendation and list what still needs research.'

/** What a merged node's result will be: reused, written once the node's reply ends, or written now. */
function resultNote(n: NodeSummary): { text: string; warn?: boolean } {
  if (n.messageCount === 0) return { text: 'No messages yet: the merge stops until it has a reply', warn: true }
  if (n.result && n.resultUpto === n.messageCount && !n.running) return { text: 'Reuses its result (nothing new since)' }
  if (n.running) return { text: 'Replying now: its result is written when the reply ends' }
  return { text: 'Its result is written when you merge' }
}

/**
 * Show what the merged node will start from, then create it. The merge node appears on the graph
 * right away ("Merging…"); each node's result is written in the background, then the merged node
 * starts working on the first message.
 */
export function MergeDialog({ projectId, nodes, parentIds, onClose }: {
  projectId: string
  nodes: NodeSummary[]
  parentIds: string[]
  onClose: () => void
}) {
  const merge = useMerge(projectId)
  const selection = useMergeSelection()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parents = parentIds.map((id) => byId.get(id)!).filter(Boolean)

  const baseId = mergeBaseOf((id) => byId.get(id)!, parentIds)
  const defaultTitle = defaultMergeTitle(parents.map((p) => p.title))
  const [title, setTitle] = useState(defaultTitle)
  const [framing, setFraming] = useState(DEFAULT_FRAMING)
  // The same rule the server applies: the branches' setting, or the model first by name.
  const catalog = useModels().data
  const rule = catalog && mergeModelSettings(parents, { model: catalog.defaultModel, effort: catalog.defaultEffort })
  // What the user picked in the dropdowns; null: still the rule's choice.
  const [picked, setPicked] = useState<ModelSettings | null>(null)
  const settings: ModelSettings | undefined = picked ?? (rule ? { model: rule.model, effort: rule.effort } : undefined)

  // The base node's full context (what the merged node starts from, besides the results).
  const base = useNodeDetail(baseId ?? '', Boolean(baseId)).data
  const baseTokens = base
    ? contextTokens(base.inherited) + base.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
    : 0

  // Branches that edited files: their files are merged too; show what each changed and any conflicts.
  const preview = useMergePreview(projectId, parentIds, parents.some((p) => p.gitBranch))
  const editedBranches = preview.data?.branches.filter((b) => b.files.length > 0) ?? []

  const create = () =>
    merge.mutate(
      // An unchanged default title is left to the server, so a model-written title can replace it later.
      {
        parentIds,
        title: title.trim() && title.trim() !== defaultTitle ? title.trim() : undefined,
        prompt: framing.trim(),
        // Left out, the server applies the same rule.
        ...(picked ?? {}),
      },
      {
        // The merge node is on the graph now, writing the results in the background.
        onSuccess: () => {
          selection.clear()
          onClose()
        },
      },
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge {parents.length} nodes</DialogTitle>
          <DialogDescription>
            The merged node appears on the graph right away. Each node's result (a short report of what it found) is
            written in the background; then the merged node starts on your first message, with the base context plus
            those results. Transcripts are left out.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg border text-sm">
          <div className="grid grid-cols-[88px_minmax(0,1fr)_auto] gap-3 px-3 py-2">
            <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Base</span>
            <span>{baseId ? byId.get(baseId)?.title : 'None: these nodes share no ancestor, so only their results are passed'}</span>
            <span className="font-mono text-xs text-muted-foreground">{baseId && `~${formatTokens(baseTokens)} tok`}</span>
          </div>
          {parents.map((p) => {
            const note = resultNote(p)
            return (
              <div key={p.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-t bg-done-soft px-3 py-2">
                <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">+ Result</span>
                <span className="min-w-0">
                  <b>{p.title}</b>
                  <span className={note.warn ? 'block text-xs text-destructive' : 'block text-xs text-muted-foreground'}>{note.text}</span>
                </span>
              </div>
            )
          })}
        </div>

        {editedBranches.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Files</span>
            {editedBranches.map((b) => (
              <p key={b.nodeId} className="text-xs">
                <b>{b.title}</b> changed <span className="font-mono">{b.files.join(', ')}</span>
              </p>
            ))}
            {preview.data!.conflicts.length > 0 ? (
              <p role="status" className="rounded-md border border-merge/40 bg-merge-soft px-2 py-1.5 text-xs text-merge">
                Overlapping changes in <span className="font-mono">{preview.data!.conflicts.join(', ')}</span>. They are merged
                with conflict markers, and the merged node is asked to resolve them first.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">The files merge without conflicts.</p>
            )}
          </div>
        )}
        {preview.isError && <p className="text-xs text-destructive">Could not preview the file merge: {preview.error.message}</p>}

        {catalog && rule && settings && (
          <div className="grid gap-1.5">
            <Label htmlFor="merge-model">Model</Label>
            <ModelFields compact value={settings} catalog={catalog} onChange={setPicked} idPrefix="merge" />
            {rule.mixedModels.length > 0 && !picked && (
              <p role="status" className="rounded-lg border border-merge/40 bg-merge-soft px-3 py-2 text-sm text-merge">
                The branches use different models ({rule.mixedModels.join(', ')}). The merged node uses{' '}
                <b>{describeSettings(rule, catalog)}</b>, the first by name, unless you pick another above.
              </p>
            )}
          </div>
        )}

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
            {merge.isPending ? 'Merging…' : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
