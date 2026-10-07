// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const file = (name: string) => ({ name, path: `/p/.harness/uploads/${name}`, size: 10 })

// The store reads localStorage once per page load: a fresh module stands for a reload.
async function freshStore() {
  vi.resetModules()
  return import('./drafts')
}

beforeEach(() => localStorage.clear())

describe('drafts', () => {
  it('keeps each node’s text, also across a reload', async () => {
    const { useDraft } = await freshStore()
    const a = renderHook(() => useDraft('a'))
    act(() => a.result.current.setText('half a thought'))
    expect(a.result.current.text).toBe('half a thought')
    expect(renderHook(() => useDraft('b')).result.current.text).toBe('')

    const reloaded = await freshStore()
    expect(renderHook(() => reloaded.useDraft('a')).result.current.text).toBe('half a thought')
  })

  it('keeps attachments, and forgets a node once its draft is empty or cleared', async () => {
    const { keepDraftFiles, useDraft, useDrafts } = await freshStore()
    const all = renderHook(() => useDrafts())
    act(() => keepDraftFiles('a').onAdded(file('x.pdf')))
    expect(all.result.current.a?.files).toEqual([file('x.pdf')])
    expect(keepDraftFiles('a').initial).toEqual([file('x.pdf')])

    act(() => keepDraftFiles('a').onRemoved(file('x.pdf')))
    expect(all.result.current.a).toBeUndefined()

    const a = renderHook(() => useDraft('a'))
    act(() => a.result.current.setText('text'))
    act(() => keepDraftFiles('a').onAdded(file('y.pdf')))
    act(() => a.result.current.clear())
    expect(all.result.current).toEqual({})
    expect(JSON.parse(localStorage.getItem('harness.drafts')!)).toEqual({})
  })

  it('starts empty when the saved drafts are unreadable', async () => {
    localStorage.setItem('harness.drafts', '{not json')
    const { useDrafts } = await freshStore()
    expect(renderHook(() => useDrafts()).result.current).toEqual({})
  })
})
