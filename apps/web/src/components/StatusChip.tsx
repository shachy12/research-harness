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
  compacting: { label: '⇲ Compacting…', className: 'bg-merge-soft text-merge tabular-nums' },
  'compact-stopped': { label: '! Compact stopped', className: 'bg-destructive/10 text-destructive' },
  working: { label: 'Working…', className: 'bg-open-soft text-open tabular-nums' },
  yours: { label: '● Your turn', className: 'bg-merge-soft text-merge' },
  failed: { label: '! No reply', className: 'bg-destructive/10 text-destructive' },
  limit: { label: '! Limit reached', className: 'bg-destructive/10 text-destructive' },
  forked: { label: '◆ Forked', className: 'bg-muted text-frozen' },
}

/** Activities shown with how long they have been going, e.g. "Working · 1:42". */
const TIMED: Partial<Record<Activity, string>> = { working: 'Working', merging: 'Merging', compacting: 'Compacting' }

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
        {(activity === 'working' || activity === 'merging' || activity === 'compacting') && <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />}
        {elapsed && TIMED[activity] ? `${TIMED[activity]} · ${elapsed}` : a.label}
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

/** A branch that started from a compact of its parent instead of the whole conversation. */
export function CompactChip() {
  return <span className={cn(chip, 'bg-muted text-muted-foreground')} title="Starts from a compact of its parent's conversation">⇲ Compact</span>
}

/** The git branch a root (and everything under it) works against. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span className={cn(chip, 'max-w-28 bg-muted font-mono font-normal text-muted-foreground')} title={`Works against the git branch ${branch}`}>
      <span className="truncate">⎇ {branch}</span>
    </span>
  )
}
