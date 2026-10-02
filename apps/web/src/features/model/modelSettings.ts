import type { Effort, ModelOption, ModelsResponse } from '@harness/shared'
import { formatTokens } from '@/lib/tokens'

/** A node's model setting; null fields mean the provider's default. */
export interface ModelSettings {
  model: string | null
  effort: Effort | null
}

/** The model that actually runs for a setting: its own, else the default. */
export const resolvedModel = (s: ModelSettings, catalog: ModelsResponse) => s.model ?? catalog.defaultModel

/** The effort levels the model of this setting takes (all levels when unknown). */
export function effortsFor(s: ModelSettings, catalog: ModelsResponse): ModelOption['efforts'] {
  const id = resolvedModel(s, catalog)
  return catalog.models.find((m) => m.id === id)?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']
}

/** The effort that actually runs: none for a model without effort levels. */
export function resolvedEffort(s: ModelSettings, catalog: ModelsResponse): Effort | null {
  return effortsFor(s, catalog).length ? (s.effort ?? catalog.defaultEffort) : null
}

/** Short text for a setting, e.g. "claude-opus-5-5 · high". */
export function describeSettings(s: ModelSettings, catalog: ModelsResponse): string {
  const effort = resolvedEffort(s, catalog)
  return effort ? `${resolvedModel(s, catalog)} · ${effort}` : resolvedModel(s, catalog)
}

/**
 * Change the model and keep the effort if the new model takes it (else back to the default),
 * so picking a model never leaves an effort it would refuse.
 */
export function withModel(s: ModelSettings, model: string | null, catalog: ModelsResponse): ModelSettings {
  const next = { ...s, model }
  return next.effort && !effortsFor(next, catalog).includes(next.effort) ? { ...next, effort: null } : next
}

/**
 * Whether going from one setting to another changes what runs, i.e. loses the prompt cache.
 * `fromModel` may name the model that actually answered last (it wins over the setting: e.g. a
 * refusal fallback answered with another model).
 */
export function changesCache(from: ModelSettings, to: ModelSettings, catalog: ModelsResponse, fromModel?: string | null): boolean {
  return changesModel(from, to, catalog, fromModel) || resolvedEffort(from, catalog) !== resolvedEffort(to, catalog)
}

function changesModel(from: ModelSettings, to: ModelSettings, catalog: ModelsResponse, fromModel?: string | null): boolean {
  if (to.model === from.model) return false
  return (fromModel ?? resolvedModel(from, catalog)) !== resolvedModel(to, catalog)
}

/**
 * The warning shown before switching a node with `tokens` of history: the first reply after the
 * switch re-reads it all without the prompt cache (caches are per model, and per effort level).
 * In the provider's terms: usage limit on Claude Code, price on the API.
 */
export function switchWarning(
  from: ModelSettings,
  to: ModelSettings,
  catalog: ModelsResponse,
  tokens: number,
  fromModel?: string | null,
): string {
  const what = changesModel(from, to, catalog, fromModel) ? `Switching to ${resolvedModel(to, catalog)}` : 'Changing the effort'
  const size = `~${formatTokens(tokens)} tokens`
  return catalog.provider === 'claude-code'
    ? `${what} re-reads this node's history (${size}) once without the prompt cache, so the next reply uses more of your Claude usage limit than usual. Later replies use the cache again.`
    : `${what} re-reads this node's history (${size}) once at the full input price, about 10× a cached read. Later replies use the cache again.`
}
