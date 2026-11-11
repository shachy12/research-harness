import type { MergeState, NodeStatus, Role } from '@harness/shared'

/**
 * What an open node is waiting for:
 *   merging     a merge node writing the results of the nodes it merges (its reply starts after)
 *   stopped     a merge node that stopped before its results were written (Retry starts it again)
 *   compacting  a compact branch whose compact of its parent is being written (its reply starts after)
 *   compact-stopped  a compact branch that stopped before its compact was written (Retry)
 *   working     the model is writing a reply
 *   yours       the model replied (or nothing was asked yet): your turn
 *   failed      the last message is yours but no reply is running (it failed or was stopped early)
 *   limit       the same, while the Claude usage limit is reached (so that is most likely why)
 *   forked      it was just forked (nothing added since): the work goes on in its branches, though
 *               it stays open to continue
 */
export type Activity = 'merging' | 'stopped' | 'compacting' | 'compact-stopped' | 'working' | 'yours' | 'failed' | 'limit' | 'forked'

export function activityOf(
  status: NodeStatus, running: boolean, lastRole: Role | null, limitReached = false, forkedAtEnd = false, merge: MergeState | null = null,
  compacting: MergeState | null = null,
): Activity | null {
  if (merge?.running) return 'merging'
  if (compacting?.running) return 'compacting'
  if (running) return 'working'
  if (merge) return 'stopped'
  if (compacting) return 'compact-stopped'
  if (status !== 'open') return null
  if (forkedAtEnd) return 'forked'
  if (lastRole !== 'user') return 'yours'
  return limitReached ? 'limit' : 'failed'
}
