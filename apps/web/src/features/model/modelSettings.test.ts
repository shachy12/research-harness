import { type ModelsResponse, mergeModelSettings } from '@harness/shared'
import { describe, expect, it } from 'vitest'
import { changesCache, describeSettings, switchWarning, withModel } from './modelSettings'

const api: ModelsResponse = {
  provider: 'placeholder',
  models: [
    { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-4-5', efforts: [] },
  ],
  defaultModel: 'claude-opus-5-5',
  defaultEffort: 'high',
  forkKeepsCache: true,
  canEdit: false,
}
const cc: ModelsResponse = { ...api, provider: 'claude-code' }
const none = { model: null, effort: null }

describe('model settings', () => {
  it('describes what actually runs', () => {
    expect(describeSettings(none, api)).toBe('claude-opus-5-5 · high')
    expect(describeSettings({ model: 'claude-sonnet-5-5', effort: 'low' }, api)).toBe('claude-sonnet-5-5 · low')
    expect(describeSettings({ model: 'claude-haiku-4-5', effort: null }, api)).toBe('claude-haiku-4-5')
  })

  it('drops an effort the new model does not take', () => {
    expect(withModel({ model: null, effort: 'max' }, 'claude-sonnet-5-5', api)).toEqual({ model: 'claude-sonnet-5-5', effort: 'max' })
    expect(withModel({ model: null, effort: 'max' }, 'claude-haiku-4-5', api)).toEqual({ model: 'claude-haiku-4-5', effort: null })
  })

  it('counts only real changes as losing the cache', () => {
    // Naming the default explicitly changes nothing that runs.
    expect(changesCache(none, { model: 'claude-opus-5-5', effort: 'high' }, api)).toBe(false)
    expect(changesCache(none, { model: 'claude-sonnet-5-5', effort: null }, api)).toBe(true)
    expect(changesCache(none, { model: null, effort: 'low' }, api)).toBe(true)
    // The model that actually wrote the last reply wins over the setting (e.g. a refusal fallback).
    expect(changesCache(none, { model: 'claude-opus-5-5', effort: null }, cc, 'claude-sonnet-5-5')).toBe(true)
  })

  it('warns in the provider’s terms', () => {
    expect(switchWarning(none, { model: 'claude-sonnet-5-5', effort: null }, api, 43_000))
      .toBe('Switching to claude-sonnet-5-5 re-reads this node’s history (~43.0k tokens) once at the full input price, about 10× a cached read. Later replies use the cache again.'.replace(/’/g, "'"))
    expect(switchWarning(none, { model: null, effort: 'low' }, cc, 500, 'claude-opus-5-5'))
      .toMatch(/^Changing the effort re-reads .* \(~500 tokens\) .* more of your Claude usage limit/)
  })

  it('picks a merged node’s setting deterministically', () => {
    const defaults = { model: 'claude-opus-5-5', effort: 'high' } as const
    // All the same: that setting, nothing to warn about.
    expect(mergeModelSettings([{ model: null, effort: null }, { model: null, effort: null }], defaults))
      .toEqual({ model: null, effort: null, mixedModels: [] })
    // Different models: the first by name, with the highest effort among the branches on it.
    expect(mergeModelSettings([
      { model: 'claude-sonnet-5-5', effort: 'max' },
      { model: null, effort: 'low' }, // = claude-opus-5-5
      { model: 'claude-opus-5-5', effort: 'xhigh' },
    ], defaults)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', mixedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'] })
    // Same model, different efforts: the highest, no warning.
    expect(mergeModelSettings([{ model: 'claude-opus-5-5', effort: 'low' }, { model: null, effort: null }], defaults))
      .toEqual({ model: 'claude-opus-5-5', effort: 'high', mixedModels: [] })
  })
})
