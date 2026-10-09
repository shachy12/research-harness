// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadFilesView, useFilesViewState } from './viewState'

describe('Files view state', () => {
  beforeEach(() => localStorage.clear())

  it('starts empty for a node never opened', () => {
    expect(loadFilesView('n1')).toEqual({ file: null, folders: {}, changedOnly: false, mode: 'file' })
  })

  it('remembers the file, folders, filter and mode per node', () => {
    const { result, unmount } = renderHook(() => useFilesViewState('n1'))
    act(() => result.current[1]({ file: 'sections/intro.tex' }))
    act(() => result.current[1]({ folders: { sections: false, figures: true } }))
    act(() => result.current[1]({ changedOnly: true, mode: 'preview' }))
    unmount()

    // Opened again later (another visit, or after a reload): as it was left.
    const again = renderHook(() => useFilesViewState('n1'))
    expect(again.result.current[0]).toEqual({
      file: 'sections/intro.tex', folders: { sections: false, figures: true }, changedOnly: true, mode: 'preview',
    })
    expect(loadFilesView('n2').file).toBeNull() // other nodes keep their own
  })

  it('ignores unreadable saved data', () => {
    localStorage.setItem('harness.filesView', '{not json')
    expect(loadFilesView('n1').mode).toBe('file')
    localStorage.setItem('harness.filesView', JSON.stringify({ n1: { file: 3, mode: 'weird', folders: 'x' } }))
    expect(loadFilesView('n1')).toEqual({ file: null, folders: {}, changedOnly: false, mode: 'file' })
  })
})
