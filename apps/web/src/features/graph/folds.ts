import type { DagNode, NodeSummary } from '@harness/shared'
import { useSyncExternalStore } from 'react'

/**
 * Folding done subtrees on the graph. A folded node hides the nodes it owns: its children, their
 * children, and so on, but only nodes whose parents are all inside the fold. A merge node with a
 * parent outside the fold belongs to another part of the graph too, so it stays visible, and its
 * dashed edge from the fold starts at the folded card.
 *
 * A node can be folded while it and everything it owns are done and need nothing from the user
 * (nothing running, unread, or still merging). When that stops being true (a hidden node got a
 * message, say), the fold opens by itself; it closes again once it holds.
 *
 * Any node can also fold just its done branches (`doneBranches`): they go into a stub card under
 * it while the node and its other branches stay. That fold is worked out anew each time too: a
 * branch marked done later joins it, one that gets a message comes back out.
 */

type Link = Pick<DagNode, 'id' | 'parentIds'>

/** The nodes a fold at `rootId` would hide, in the order given. */
export function foldContents(nodes: Link[], rootId: string): string[] {
  const inside = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (!inside.has(n.id) && n.parentIds.length > 0 && n.parentIds.every((p) => inside.has(p))) {
        inside.add(n.id)
        grew = true
      }
    }
  }
  return nodes.filter((n) => n.id !== rootId && inside.has(n.id)).map((n) => n.id)
}

/** Done, and nothing on it waits for the user. */
function settled(n: NodeSummary): boolean {
  return n.status === 'finished' && !n.running && !n.merge && n.unread === 0
}

/** Every node that can be folded now, with the nodes the fold would hide. */
export function foldableNodes(nodes: NodeSummary[]): Map<string, string[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const result = new Map<string, string[]>()
  for (const n of nodes) {
    // The folded card stays on screen, so only what it hides has to be read.
    if (n.status !== 'finished' || n.running || n.merge) continue
    const contents = foldContents(nodes, n.id)
    if (contents.length > 0 && contents.every((id) => settled(byId.get(id)!))) result.set(n.id, contents)
  }
  return result
}

/**
 * The done branches of a node, which it can fold away whatever its own state and its other
 * branches' (shown as a stub card under it): each child that has only this parent, when it and
 * everything it owns are done and need nothing from the user. A merge of such branches that is
 * settled too goes with them; a merge with a parent elsewhere stays on screen.
 */
export function doneBranches(
  nodes: NodeSummary[],
  parentId: string,
  contentsOf: (id: string) => string[] = (id) => foldContents(nodes, id),
): { branches: string[]; hidden: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hidden = new Set<string>()
  const branches: string[] = []
  for (const c of nodes) {
    if (c.parentIds.length !== 1 || c.parentIds[0] !== parentId || !settled(c)) continue
    const contents = contentsOf(c.id)
    if (!contents.every((id) => settled(byId.get(id)!))) continue
    branches.push(c.id)
    hidden.add(c.id)
    contents.forEach((id) => hidden.add(id))
  }
  let grew = branches.length > 0
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (!hidden.has(n.id) && n.parentIds.length > 0 && n.parentIds.every((p) => hidden.has(p)) && settled(n)) {
        hidden.add(n.id)
        grew = true
      }
    }
  }
  return { branches, hidden: nodes.filter((n) => hidden.has(n.id)).map((n) => n.id) }
}

/** The id of the stub card that stands for a node's folded done branches. */
export const stubId = (parentId: string) => `done-branches:${parentId}`

export interface BranchStub {
  id: string
  /** The node whose done branches it hides (it sits under that node). */
  parentId: string
  /** The titles of the branches it hides. */
  branches: string[]
  /** How many nodes it hides in all. */
  nodes: number
}

export interface FoldedGraph {
  /** The nodes on screen; `parentIds` point at the folded card or stub where a parent is hidden. */
  visible: { summary: NodeSummary; parentIds: string[] }[]
  /** Stub cards on screen. */
  stubs: BranchStub[]
  /** Folded cards on screen, with how many nodes each hides. */
  folded: Map<string, number>
  /** Cards on screen that can be folded, with how many nodes they would hide. */
  foldable: Map<string, number>
  /** Cards on screen that can fold their done branches (and can't fold whole), with how many branches. */
  branchFoldable: Map<string, number>
  /** What "Fold done" folds: the foldable cards on screen that no other fold would hide, */
  foldAll: string[]
  /** and every card that can fold its done branches. */
  foldAllBranches: string[]
}

export function applyFolds(nodes: NodeSummary[], foldedIds: readonly string[], branchFoldedIds: readonly string[] = []): FoldedGraph {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const contentsCache = new Map<string, string[]>()
  const contentsOf = (id: string) => {
    if (!contentsCache.has(id)) contentsCache.set(id, foldContents(nodes, id))
    return contentsCache.get(id)!
  }
  const foldable = foldableNodes(nodes)
  // Which fold hides each hidden node: a folded card or a stub. Folds nest (a fold inside a fold
  // hides a subset of it), so the card that shows for a hidden node is found by following this up
  // to one on screen. A stub whose own node is hidden leads on to that node.
  const hiddenBy = new Map<string, string>()
  for (const id of foldedIds) {
    for (const hidden of foldable.get(id) ?? []) hiddenBy.set(hidden, id)
  }
  const branchFolds = new Map<string, string[]>()
  for (const id of branchFoldedIds) {
    // A node folded whole needs no stub: its fold hides its branches already.
    if (!byId.has(id) || (foldedIds.includes(id) && foldable.has(id))) continue
    const fold = doneBranches(nodes, id, contentsOf)
    if (fold.branches.length === 0) continue
    branchFolds.set(id, fold.branches)
    for (const hidden of fold.hidden) if (!hiddenBy.has(hidden)) hiddenBy.set(hidden, stubId(id))
  }
  for (const id of branchFolds.keys()) if (hiddenBy.has(id)) hiddenBy.set(stubId(id), id)
  const shownFor = (id: string): string => {
    let at = id
    while (hiddenBy.has(at)) at = hiddenBy.get(at)!
    return at
  }

  const visible = nodes
    .filter((n) => !hiddenBy.has(n.id))
    .map((summary) => ({ summary, parentIds: [...new Set(summary.parentIds.map(shownFor))] }))
  const counts = new Map<string, number>()
  for (const n of nodes) {
    if (!hiddenBy.has(n.id)) continue
    const card = shownFor(n.id)
    counts.set(card, (counts.get(card) ?? 0) + 1)
  }
  const folded = new Map([...counts].filter(([id]) => byId.has(id)))
  const stubs: BranchStub[] = []
  for (const [parentId, branches] of branchFolds) {
    const id = stubId(parentId)
    if (hiddenBy.has(id) || !counts.has(id)) continue
    const titles = branches.filter((b) => shownFor(b) === id).map((b) => byId.get(b)!.title)
    stubs.push({ id, parentId, branches: titles, nodes: counts.get(id)! })
  }

  const shownFoldable = new Map<string, number>()
  for (const [id, contents] of foldable) {
    if (!hiddenBy.has(id) && !folded.has(id)) shownFoldable.set(id, contents.length)
  }
  // A card that can fold whole offers only that; one whose done branches are folded already has
  // nothing more to fold (branches done later join its stub by themselves).
  const branchFoldable = new Map<string, number>()
  for (const { summary } of visible) {
    const id = summary.id
    if (shownFoldable.has(id) || folded.has(id) || branchFolds.has(id)) continue
    const count = doneBranches(nodes, id, contentsOf).branches.length
    if (count > 0) branchFoldable.set(id, count)
  }
  // "Fold all" folds only the outermost ones: a fold inside another would stay folded when the
  // outer one is opened.
  const nested = new Set([...foldable.values()].flat())
  const foldAll = [...shownFoldable.keys()].filter((id) => !nested.has(id))
  return { visible, stubs, folded, foldable: shownFoldable, branchFoldable, foldAll, foldAllBranches: [...branchFoldable.keys()] }
}

/**
 * A list of node ids kept in localStorage, so folds survive a reload and an app restart. Node ids
 * are unique across projects, so one list serves all of them.
 */
function storedList(key: string) {
  let ids: string[] | null = null
  const listeners = new Set<() => void>()

  const load = (): string[] => {
    if (ids) return ids
    ids = []
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (Array.isArray(saved)) ids = saved.filter((id): id is string => typeof id === 'string')
    } catch {
      // Unreadable or blocked storage: start with nothing folded.
    }
    return ids
  }
  const set = (next: string[]) => {
    ids = next
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Storage full or blocked: the folds still hold until the page reloads.
    }
    listeners.forEach((l) => l())
  }
  return {
    load,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The actions read the current list, not a value captured at render time.
    add: (more: string[]) => set([...new Set([...load(), ...more])]),
    remove: (gone: string[]) => set(load().filter((id) => !gone.includes(id))),
  }
}

/** Nodes folded whole. */
const foldedNodes = storedList('harness.foldedNodes')
/** Nodes whose done branches are folded. */
const foldedBranches = storedList('harness.foldedBranches')

export function useFoldedNodes() {
  const ids = useSyncExternalStore(foldedNodes.subscribe, foldedNodes.load)
  const branchIds = useSyncExternalStore(foldedBranches.subscribe, foldedBranches.load)
  return {
    ids,
    branchIds,
    fold: foldedNodes.add,
    unfold: foldedNodes.remove,
    foldBranches: foldedBranches.add,
    unfoldBranches: foldedBranches.remove,
  }
}
