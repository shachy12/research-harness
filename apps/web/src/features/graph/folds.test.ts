import type { NodeSummary } from '@harness/shared'
import { describe, expect, it } from 'vitest'
import { applyFolds, doneBranches, foldContents, foldableNodes, stubId } from './folds'

const node = (id: string, parentIds: string[] = [], over: Partial<NodeSummary> = {}) =>
  ({ id, title: id, parentIds, status: 'finished', running: false, merge: null, unread: 0, ...over }) as NodeSummary
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

describe('doneBranches', () => {
  it('takes the done children a node alone owns, with what they own, whatever the node’s own state', () => {
    expect(doneBranches(graph(), 'rc')).toEqual({ branches: ['lpn'], hidden: ['lpn', 'is', 'mt'] })
    expect(doneBranches(graph(), 'root').branches).toEqual([]) // fdb and rc are open; mg has other parents
  })

  it('leaves a done branch out while something under it is not settled', () => {
    const nodes = graph().map((n) => (n.id === 'mt' ? { ...n, running: true } : n))
    expect(doneBranches(nodes, 'rc').branches).toEqual([])
  })

  it('takes a settled merge of its done branches along', () => {
    const nodes = [node('p', [], open), node('c1', ['p']), node('c2', ['p']), node('m', ['c1', 'c2']), node('o', ['p'], open)]
    expect(doneBranches(nodes, 'p')).toEqual({ branches: ['c1', 'c2'], hidden: ['c1', 'c2', 'm'] })
  })
})

describe('applyFolds with done branches folded', () => {
  it('puts the done branches in a stub under their node, the rest stays', () => {
    const shown = applyFolds(graph(), [], ['rc'])
    expect(shown.visible.map((v) => v.summary.id)).toEqual(['root', 'fdb', 'rc', 'gpu', 'w', 'mg'])
    expect(shown.stubs).toEqual([{ id: stubId('rc'), parentId: 'rc', branches: ['lpn'], nodes: 3 }])
    // The merge's edge from a hidden parent starts at the stub.
    expect(shown.visible.find((v) => v.summary.id === 'mg')!.parentIds).toEqual(['root', 'gpu', stubId('rc')])
    expect(shown.folded.size).toBe(0)
    expect(shown.branchFoldable.has('rc')).toBe(false)
  })

  it('offers it on cards with done branches that can’t fold whole', () => {
    const shown = applyFolds(graph(), [])
    expect(shown.branchFoldable).toEqual(new Map([['fdb', 1], ['rc', 1]]))
    expect([...shown.foldable.keys()]).toEqual(['lpn'])
    expect(shown.foldAllBranches).toEqual(['fdb', 'rc'])
  })

  it('follows the branches: one done later joins, one that gets a message comes back', () => {
    const later = graph().map((n) => (n.id === 'w' ? { ...n, status: 'finished' as const, running: false } : n))
    expect(applyFolds(later, [], ['rc']).stubs[0]).toMatchObject({ branches: ['w', 'lpn'], nodes: 4 })
    const back = graph().map((n) => (n.id === 'is' ? { ...n, unread: 1 } : n))
    const shown = applyFolds(back, [], ['rc'])
    expect(shown.stubs).toEqual([])
    expect(shown.visible).toHaveLength(back.length)
  })

  it('shows no stub inside a fold: the folded card counts its nodes', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['b'])]
    const shown = applyFolds(nodes, ['a'], ['b'])
    expect(shown.stubs).toEqual([])
    expect(shown.folded).toEqual(new Map([['a', 2]]))
    // A node folded whole shows no stub of its own either.
    expect(applyFolds(nodes, ['b'], ['b']).stubs).toEqual([])
  })

  it('nests: a stub inside another stub counts for the outer one', () => {
    const nodes = [node('p', [], open), node('q', ['p']), node('r', ['q']), node('s', ['q'], open)]
    // q is done but has an open branch, so it stays; its done branch r goes into q's stub.
    const shown = applyFolds(nodes, [], ['p', 'q'])
    expect(shown.visible.map((v) => v.summary.id)).toEqual(['p', 'q', 's'])
    expect(shown.stubs).toEqual([{ id: stubId('q'), parentId: 'q', branches: ['r'], nodes: 1 }])
  })
})
