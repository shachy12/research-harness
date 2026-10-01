import type { NodeStatus } from '@harness/shared'
import { cn } from '@/lib/utils'

const STATUS: Record<NodeStatus, { icon: string; label: string; className: string }> = {
  open: { icon: '○', label: 'Open', className: 'bg-open-soft text-open' },
  frozen: { icon: '◆', label: 'Forked', className: 'bg-muted text-frozen' },
  finished: { icon: '✓', label: 'Finished', className: 'bg-done-soft text-done' },
}

export function StatusChip({ status, className }: { status: NodeStatus; className?: string }) {
  const s = STATUS[status]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', s.className, className)}>
      {s.icon} {s.label}
    </span>
  )
}

export function MergeChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-merge-soft px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-merge">
      ⑃ Merge
    </span>
  )
}
