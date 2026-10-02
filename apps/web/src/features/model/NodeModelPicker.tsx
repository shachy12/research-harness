import type { DagNode } from '@harness/shared'
import { useState } from 'react'
import { useModels, useSetNodeModel } from '@/api/queries'
import { ModelFields } from './ModelFields'
import { type ModelSettings, changesCache, switchWarning } from './modelSettings'

/**
 * The model and effort dropdowns by the composer. A change applies right away to the node's next
 * replies. While the setting differs from the one the last reply used, a note says what the next
 * reply costs (it re-reads the history without the prompt cache), so it can be switched back first.
 */
export function NodeModelPicker({ node, replyCount, historyTokens, lastReplyModel, disabled }: {
  node: DagNode
  /** Replies so far: the setting in use when the latest one arrived is the one the cache belongs to. */
  replyCount: number
  /** Estimated tokens the next prompt re-reads (inherited + the node's own messages). */
  historyTokens: number
  /** The model that wrote the last reply, if known. */
  lastReplyModel: string | null
  disabled: boolean
}) {
  const catalog = useModels().data
  const save = useSetNodeModel()
  const saved: ModelSettings = { model: node.model, effort: node.effort }
  // Show a change at once, before the refetched node confirms it.
  const value: ModelSettings = save.isPending && save.variables ? { model: save.variables.model, effort: save.variables.effort } : saved

  // The setting the latest reply was written with (updated whenever a new reply arrives).
  const [cached, setCached] = useState({ replyCount, settings: saved })
  if (cached.replyCount !== replyCount) setCached({ replyCount, settings: saved })

  if (!catalog) return null
  const warn = replyCount > 0 && historyTokens > 0 && changesCache(cached.settings, value, catalog, lastReplyModel)

  return (
    <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
      <ModelFields
        compact
        value={value}
        catalog={catalog}
        disabled={disabled || save.isPending}
        onChange={(next) => save.mutate({ nodeId: node.id, ...next })}
        idPrefix="composer"
      />
      {warn && (
        <p role="status" className="max-w-md text-right text-xs text-merge">
          {switchWarning(cached.settings, value, catalog, historyTokens, lastReplyModel)}
        </p>
      )}
      {save.isError && <p className="text-xs text-destructive">{save.error.message}</p>}
    </div>
  )
}
