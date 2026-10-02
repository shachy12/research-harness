import type { NodeSummary } from '@harness/shared'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { MergeChip, StatusChip } from '@/components/StatusChip'
import { formatElapsed } from '@harness/shared'
import { activityOf } from '@/lib/activity'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { CARD_HEIGHT, CARD_WIDTH } from './layout'

export type CardData = {
  summary: NodeSummary
  mergeSelected: boolean
  /** Changes each time the card should shake (right-click on a node that can't be merged). */
  shakeKey: number
}
export type CardNode = Node<CardData, 'card'>

// Edges attach to invisible handles at the top and bottom of each card.
const hiddenHandle = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

export function NodeCard({ data }: NodeProps<CardNode>) {
  const { summary: n, mergeSelected, shakeKey } = data
  const now = useNow(n.running)
  const elapsed = n.run ? formatElapsed(now - Date.parse(n.run.startedAt)) : undefined

  return (
    <div
      key={shakeKey}
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
      className={cn(
        'flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors hover:border-edge',
        mergeSelected && 'border-merge ring-3 ring-merge-soft',
        n.running && !mergeSelected && 'border-open/60',
        shakeKey > 0 && 'animate-shake',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className={hiddenHandle} />
      <div className="flex items-center gap-1.5">
        <StatusChip status={n.status} activity={activityOf(n.status, n.running, n.lastRole)} elapsed={elapsed} />
        {n.parentIds.length > 1 && <MergeChip />}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{n.messageCount} msg</span>
      </div>
      <div className="line-clamp-1 text-sm font-semibold">{n.title}</div>
      {mergeSelected ? (
        <div className="self-start rounded-full bg-merge-soft px-2 py-0.5 text-[11px] font-semibold text-merge">
          ⑃ Selected for merge
        </div>
      ) : n.run ? (
        <div className="line-clamp-2 text-xs text-open italic">{n.run.activity}…</div>
      ) : n.result ? (
        <div className="line-clamp-2 rounded-md bg-done-soft px-2 py-1 text-xs">
          <b className="text-done">Result:</b> {n.result.findings}
        </div>
      ) : (
        <div className="line-clamp-2 text-xs text-muted-foreground">{n.lastMessage ?? 'No messages yet'}</div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={hiddenHandle} />
    </div>
  )
}
