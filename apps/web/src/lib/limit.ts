import type { UsageLimit } from '@harness/shared'

const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

/** "5-hour limit", "weekly limit", or "usage limit" when unknown. */
export function limitName(usage: Pick<UsageLimit, 'limitType'>): string {
  const name = usage.limitType ? LIMIT_NAMES[usage.limitType] : undefined
  return name ? `${name} limit` : 'usage limit'
}

/** "17:00 (in 2 h 10 min)", or "Fri 09:00 (in 3 days)" further out. */
export function describeReset(resetsAt: string, now: number): string {
  const at = new Date(resetsAt)
  const ms = at.getTime() - now
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = at.toDateString() === new Date(now).toDateString()
  const when = sameDay ? time : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${when} (${relative(ms)})`
}

function relative(ms: number): string {
  if (ms <= 60_000) return 'any moment now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  const days = Math.round(hours / 24)
  return `in ${days} ${days === 1 ? 'day' : 'days'}`
}
