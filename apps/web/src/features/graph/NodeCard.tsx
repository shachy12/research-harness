import type { NodeSummary } from '@harness/shared'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { FilePenIcon, FoldVerticalIcon, PencilIcon, Trash2Icon, UnfoldVerticalIcon } from 'lucide-react'
import { MergeChip, StatusChip } from '@/components/StatusChip'
import { formatElapsed } from '@harness/shared'
import { useDrafts } from '@/features/chat/drafts'
import { activityOf } from '@/lib/activity'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { CARD_HEIGHT, CARD_WIDTH } from './layout'

export type CardData = {
  summary: NodeSummary
  mergeSelected: boolean
  /** Changes each time the card should shake (right-click on a node that can't be merged). */
  shakeKey: number
  /** The Claude usage limit is reached: a node without a reply shows that instead of "No reply". */
  limitReached: boolean
  /** How many nodes this card's fold hides (0: not folded). */
  folded: number
  /** How many nodes folding this card would hide (0: it can't be folded now). */
  foldable: number
  onRename: (node: NodeSummary) => void
  onDelete: (node: NodeSummary) => void
  onFold: (ids: string[]) => void
  onUnfold: (ids: string[]) => void
}
export type CardNode = Node<CardData, 'card'>

// Edges attach to invisible handles at the top and bottom of each card.
const hiddenHandle = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

export function NodeCard({ data }: NodeProps<CardNode>) {
  const { summary: n, mergeSelected, shakeKey, limitReached, folded, foldable, onRename, onDelete, onFold, onUnfold } = data
  const merging = n.merge?.running === true
  const now = useNow(n.running || merging)
  const startedAt = n.run?.startedAt ?? n.merge?.startedAt
  const elapsed = startedAt ? formatElapsed(now - Date.parse(startedAt)) : undefined
  const draft = useDrafts()[n.id]

  return (
    <div className="relative">
      {folded > 0 && (
        // Two cards peeking out behind: the nodes this fold hides.
        <>
          <div aria-hidden="true" className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-done/70 bg-done-soft" />
          <div aria-hidden="true" className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl border border-done/70 bg-done-soft" />
        </>
      )}
      <div
        key={shakeKey}
        style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
        className={cn(
          'group relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors hover:border-edge',
          mergeSelected && 'border-merge ring-3 ring-merge-soft',
          n.running && !mergeSelected && 'border-open/60',
          n.status === 'finished' && !n.running && !mergeSelected && 'border-done/70 bg-done-soft',
          shakeKey > 0 && 'animate-shake',
        )}
      >
        <Handle type="target" position={Position.Top} isConnectable={false} className={hiddenHandle} />
        <div className="flex items-center gap-1.5">
          <StatusChip status={n.status} activity={activityOf(n.status, n.running, n.lastRole, limitReached, n.forkedAtEnd, n.merge)} elapsed={elapsed} />
          {n.parentIds.length > 1 && <MergeChip />}
          {n.unread > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none font-semibold text-primary-foreground">
              {n.unread} new
            </span>
          )}
          {draft && (
            <span
              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold text-muted-foreground"
              title={draft.text.trim() ? `Unsent: ${draft.text.trim().slice(0, 200)}` : 'Unsent attachments'}
            >
              ✎ Draft
            </span>
          )}
          {n.proposedBranches > 0 && (
            <span
              className="rounded-full bg-open-soft px-1.5 py-0.5 text-[10px] leading-none font-semibold text-open"
              title="The model proposed branches; open the chat to review and start them"
            >
              ⑂ {n.proposedBranches} proposed
            </span>
          )}
          {n.filesChanged ? (
            <span
              className="ml-auto flex items-center gap-0.5 font-mono text-[11px] text-open"
              title={`Its branch changes ${n.filesChanged} ${n.filesChanged === 1 ? 'file' : 'files'} compared with the project`}
            >
              <FilePenIcon className="size-3" /> {n.filesChanged}
            </span>
          ) : null}
          <span className={cn('font-mono text-[11px] text-muted-foreground', !n.filesChanged && 'ml-auto')}>{n.messageCount} msg</span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <div className="line-clamp-1 min-w-0 text-sm font-semibold" title={n.title}>{n.title}</div>
          <button
            type="button"
            aria-label={`Rename "${n.title}"`}
            title="Rename"
            className="nodrag shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation() // don't open the chat
              onRename(n)
            }}
          >
            <PencilIcon className="size-3.5" />
          </button>
          {foldable > 0 && (
            <button
              type="button"
              aria-label={`Fold the ${foldable} done ${foldable === 1 ? 'node' : 'nodes'} under "${n.title}"`}
              title={`Fold the ${foldable} done ${foldable === 1 ? 'node' : 'nodes'} under it`}
              className="nodrag shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation() // don't open the chat
                onFold([n.id])
              }}
            >
              <FoldVerticalIcon className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Delete "${n.title}"`}
            title="Delete"
            className="nodrag shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation() // don't open the chat
              onDelete(n)
            }}
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
        {mergeSelected ? (
          <div className="self-start rounded-full bg-merge-soft px-2 py-0.5 text-[11px] font-semibold text-merge">
            ⑃ Selected for merge
          </div>
        ) : folded > 0 ? (
          <button
            type="button"
            title="Show the nodes in this fold"
            className="nodrag flex items-center gap-1 self-start rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold text-done hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation() // don't open the chat
              onUnfold([n.id])
            }}
          >
            <UnfoldVerticalIcon className="size-3" /> {folded} done {folded === 1 ? 'node' : 'nodes'} folded · Show
          </button>
        ) : n.run?.approval ? (
          <div className="self-start rounded-full bg-merge-soft px-2 py-0.5 text-[11px] font-semibold text-merge">
            ! Needs your approval to ask other nodes
          </div>
        ) : n.run ? (
          <div className="line-clamp-2 text-xs text-open italic">{n.run.activity}…</div>
        ) : n.merge?.running ? (
          <div className="line-clamp-2 text-xs text-merge italic">{n.merge.activity}…</div>
        ) : n.merge ? (
          <div className="line-clamp-2 text-xs text-destructive">{n.merge.error}</div>
        ) : (
          <div className="line-clamp-2 text-xs text-muted-foreground">{n.lastMessage ?? 'No messages yet'}</div>
        )}
        <Handle type="source" position={Position.Bottom} isConnectable={false} className={hiddenHandle} />
      </div>
    </div>
  )
}
