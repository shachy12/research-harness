import type { NodeStatus } from '@harness/shared'
import { LoaderIcon } from 'lucide-react'
import type { Activity } from '@/lib/activity'
import { cn } from '@/lib/utils'

const STATUS: Record<NodeStatus, { icon: string; label: string; className: string }> = {
  open: { icon: '○', label: 'Open', className: 'bg-open-soft text-open' },
  finished: { icon: '✓', label: 'Done', className: 'bg-done-soft text-done' },
}

const ACTIVITY: Record<Activity, { label: string; className: string }> = {
  merging: { label: '⑃ Merging…', className: 'bg-merge-soft text-merge tabular-nums' },
  stopped: { label: '! Merge stopped', className: 'bg-destructive/10 text-destructive' },
  working: { label: 'Working…', className: 'bg-open-soft text-open tabular-nums' },
  yours: { label: '● Your turn', className: 'bg-merge-soft text-merge' },
  failed: { label: '! No reply', className: 'bg-destructive/10 text-destructive' },
  limit: { label: '! Limit reached', className: 'bg-destructive/10 text-destructive' },
  forked: { label: '◆ Forked', className: 'bg-muted text-frozen' },
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap'

/**
 * An open node shows what it's waiting for; a node marked done shows that.
 * `elapsed` (e.g. "1:42") is shown while working, so a long research turn visibly keeps going.
 */
export function StatusChip({ status, activity = null, elapsed, className }: {
  status: NodeStatus
  activity?: Activity | null
  elapsed?: string
  className?: string
}) {
  if (activity) {
    const a = ACTIVITY[activity]
    return (
      <span className={cn(chip, a.className, className)}>
        {(activity === 'working' || activity === 'merging') && <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />}
        {activity === 'working' && elapsed ? `Working · ${elapsed}` : activity === 'merging' && elapsed ? `Merging · ${elapsed}` : a.label}
      </span>
    )
  }
  const s = STATUS[status]
  return (
    <span className={cn(chip, s.className, className)}>
      {s.icon} {s.label}
    </span>
  )
}

export function MergeChip() {
  return <span className={cn(chip, 'bg-merge-soft text-merge')}>⑃ Merge</span>
}
