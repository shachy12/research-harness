import type { NodeStatus } from '@harness/shared'
import { LoaderIcon } from 'lucide-react'
import type { Activity } from '@/lib/activity'
import { cn } from '@/lib/utils'

const STATUS: Record<NodeStatus, { icon: string; label: string; className: string }> = {
  open: { icon: '○', label: 'Open', className: 'bg-open-soft text-open' },
  frozen: { icon: '◆', label: 'Forked', className: 'bg-muted text-frozen' },
  finished: { icon: '✓', label: 'Finished', className: 'bg-done-soft text-done' },
}

const ACTIVITY: Record<Activity, { label: string; className: string }> = {
  working: { label: 'Working…', className: 'bg-open-soft text-open' },
  yours: { label: '● Your turn', className: 'bg-merge-soft text-merge' },
  failed: { label: '! No reply', className: 'bg-destructive/10 text-destructive' },
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap'

/** An open node shows what it's waiting for; forked and finished nodes show their status. */
export function StatusChip({ status, activity = null, className }: {
  status: NodeStatus
  activity?: Activity | null
  className?: string
}) {
  if (activity) {
    const a = ACTIVITY[activity]
    return (
      <span className={cn(chip, a.className, className)}>
        {activity === 'working' && <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />}
        {a.label}
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
