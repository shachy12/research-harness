import type { NodeStatus, Role } from '@harness/shared'

/**
 * What an open node is waiting for:
 *   working  the model is writing a reply
 *   yours    the model replied (or nothing was asked yet): your turn
 *   failed   the last message is yours but no reply is running (it failed or was stopped early)
 *   limit    the same, while the Claude usage limit is reached (so that is most likely why)
 */
export type Activity = 'working' | 'yours' | 'failed' | 'limit'

export function activityOf(status: NodeStatus, running: boolean, lastRole: Role | null, limitReached = false): Activity | null {
  if (running) return 'working'
  if (status !== 'open') return null
  if (lastRole !== 'user') return 'yours'
  return limitReached ? 'limit' : 'failed'
}
