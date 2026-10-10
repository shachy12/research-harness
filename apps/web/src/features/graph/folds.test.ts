import type { NodeSummary } from '@harness/shared'
import { describe, expect, it } from 'vitest'
import { applyFolds, foldContents, foldableNodes } from './folds'

const node = (id: string, parentIds: string[] = [], over: Partial<NodeSummary> = {}) =>
  ({ id, parentIds, status: 'finished', running: false, merge: null, unread: 0, ...over }) as NodeSummary
const open = { status: 'open' } as const

// The shape of a real graph: root forks fdb and rc; fdb → gpu; rc → lpn (with two done
// children) and a working branch; mg merges root, gpu and lpn.
const graph = () => [
  node('root', [], open),
  node('fdb', ['root'], open),
  node('rc', ['root'], open),
  node('gpu', ['fdb']),
  node('w', ['rc'], { ...open, running: true }),
  node('lpn', ['rc']),
  node('mg', ['root', 'gpu', 'lpn']),
  node('is', ['lpn']),
  node('mt', ['lpn']),
]

describe('foldContents', () => {
  it('takes nodes whose parents are all inside, never a merge with a parent outside', () => {
    expect(foldContents(graph(), 'lpn')).toEqual(['is', 'mt'])
    expect(foldContents(graph(), 'gpu')).toEqual([])
  })

  it('takes a merge of nodes that are all inside, and what comes after it', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['a']), node('m', ['b', 'c']), node('n', ['m'])]
    expect(foldContents(nodes, 'a')).toEqual(['b', 'c', 'm', 'n'])
  })
})

describe('foldableNodes', () => {
  it('needs a done node that hides something', () => {
    expect([...foldableNodes(graph()).keys()]).toEqual(['lpn'])
  })

  it('refuses while a node inside is open, running, unread or still merging', () => {
    for (const over of [open, { running: true }, { unread: 1 }, { merge: {} as NodeSummary['merge'] }]) {
      const nodes = graph().map((n) => (n.id === 'is' ? { ...n, ...over } : n))
      expect(foldableNodes(nodes).has('lpn')).toBe(false)
    }
  })

  it('allows unread replies on the folded card itself, which stays on screen', () => {
    const nodes = graph().map((n) => (n.id === 'lpn' ? { ...n, unread: 2 } : n))
    expect(foldableNodes(nodes).has('lpn')).toBe(true)
  })
})

describe('applyFolds', () => {
  it('hides the fold and draws edges from hidden nodes from the folded card', () => {
    const nodes = [node('a'), node('b', ['a']), node('x', [], open), node('m', ['b', 'x'])]
    const shown = applyFolds(nodes, ['a'])
    expect(shown.visible.map((v) => v.summary.id)).toEqual(['a', 'x', 'm'])
    expect(shown.visible.find((v) => v.summary.id === 'm')!.parentIds).toEqual(['a', 'x'])
    expect(shown.folded).toEqual(new Map([['a', 1]]))
    expect(shown.foldable.size).toBe(0)
  })

  it('keeps the merge visible on a real-looking graph', () => {
    const shown = applyFolds(graph(), ['lpn'])
    expect(shown.visible.map((v) => v.summary.id)).toEqual(['root', 'fdb', 'rc', 'gpu', 'w', 'lpn', 'mg'])
    expect(shown.visible.find((v) => v.summary.id === 'mg')!.parentIds).toEqual(['root', 'gpu', 'lpn'])
  })

  it('opens a fold by itself while it no longer holds', () => {
    const nodes = graph().map((n) => (n.id === 'mt' ? { ...n, unread: 1 } : n))
    const shown = applyFolds(nodes, ['lpn'])
    expect(shown.visible).toHaveLength(nodes.length)
    expect(shown.folded.size).toBe(0)
  })

  it('counts a fold inside a fold for the outer card, and folds only the outermost with "fold all"', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['b']), node('d', ['c'])]
    expect(applyFolds(nodes, []).foldAll).toEqual(['a'])
    expect([...applyFolds(nodes, []).foldable.keys()]).toEqual(['a', 'b', 'c'])
    const shown = applyFolds(nodes, ['b', 'a'])
    expect(shown.visible.map((v) => v.summary.id)).toEqual(['a'])
    expect(shown.folded).toEqual(new Map([['a', 3]]))
    // Opening the outer fold leaves the inner one folded.
    expect(applyFolds(nodes, ['b']).folded).toEqual(new Map([['b', 2]]))
  })
})
