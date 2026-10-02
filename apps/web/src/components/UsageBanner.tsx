import type { UsageLimit } from '@harness/shared'
import { GaugeIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { describeReset, limitName } from '@/lib/limit'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

// From this share of the limit on (or when the share is unknown), the warning stands out.
const HIGH_USE = 0.75

/**
 * The Claude usage limit: reached (replies fail until it resets) or a warning with how much is used.
 * Account-wide, so the graph and every chat show it. `children` go at the end (e.g. "Retry all").
 */
export function UsageBanner({ usage, className, children }: {
  usage: UsageLimit | null | undefined
  className?: string
  children?: ReactNode
}) {
  const now = useNow(Boolean(usage?.resetsAt), 30_000)
  if (!usage) return null
  const reset = usage.resetsAt ? describeReset(usage.resetsAt, now) : null
  const reached = usage.status === 'reached'
  const used = usage.utilization
  const high = reached || used === null || used >= HIGH_USE
  const percent = used === null ? null : Math.min(100, Math.floor(used * 100))

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-sm',
        reached
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : high
            ? 'border-merge/40 bg-merge-soft text-merge'
            : 'bg-card text-muted-foreground',
        className,
      )}
    >
      <GaugeIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {reached ? (
          <>
            <b>Claude {limitName(usage)} reached.</b> Replies fail until it resets{reset ? ` at ${reset}` : ''}.
          </>
        ) : (
          <>
            <b className={cn(!high && 'text-foreground')}>
              {percent === null
                ? `Close to your Claude ${limitName(usage)}.`
                : `${percent}% of your Claude ${limitName(usage)} used.`}
            </b>{' '}
            {reset ? `Resets ${reset.startsWith('any') ? reset : `at ${reset}`}.` : ''}
            {high && ' Starting many branches at once now may hit it.'}
          </>
        )}
      </span>
      {percent !== null && !reached && (
        <span
          className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="Share of the limit used"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className={cn('block h-full rounded-full', high ? 'bg-merge' : 'bg-open')} style={{ width: `${percent}%` }} />
        </span>
      )}
      {children}
    </div>
  )
}
