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

export interface FoldedGraph {
  /** The nodes on screen; `parentIds` point at the folded card where a parent is hidden. */
  visible: { summary: NodeSummary; parentIds: string[] }[]
  /** Folded cards on screen, with how many nodes each hides. */
  folded: Map<string, number>
  /** Cards on screen that can be folded, with how many nodes they would hide. */
  foldable: Map<string, number>
  /** What "Fold all done" folds: the foldable cards on screen that no other fold would hide. */
  foldAll: string[]
}

export function applyFolds(nodes: NodeSummary[], foldedIds: readonly string[]): FoldedGraph {
  const foldable = foldableNodes(nodes)
  // Which fold hides each hidden node. Folds nest (a fold inside a fold hides a subset of it), so
  // the card that shows for a hidden node is found by following this up to a node on screen.
  const hiddenBy = new Map<string, string>()
  for (const id of foldedIds) {
    for (const hidden of foldable.get(id) ?? []) hiddenBy.set(hidden, id)
  }
  const shownFor = (id: string): string => {
    let at = id
    while (hiddenBy.has(at)) at = hiddenBy.get(at)!
    return at
  }

  const visible = nodes
    .filter((n) => !hiddenBy.has(n.id))
    .map((summary) => ({ summary, parentIds: [...new Set(summary.parentIds.map(shownFor))] }))
  const folded = new Map<string, number>()
  for (const hidden of hiddenBy.keys()) {
    const card = shownFor(hidden)
    folded.set(card, (folded.get(card) ?? 0) + 1)
  }
  const shownFoldable = new Map<string, number>()
  for (const [id, contents] of foldable) {
    if (!hiddenBy.has(id) && !folded.has(id)) shownFoldable.set(id, contents.length)
  }
  // "Fold all" folds only the outermost ones: a fold inside another would stay folded when the
  // outer one is opened.
  const nested = new Set([...foldable.values()].flat())
  const foldAll = [...shownFoldable.keys()].filter((id) => !nested.has(id))
  return { visible, folded, foldable: shownFoldable, foldAll }
}

// Which nodes the user folded. Node ids are unique across projects, so one list serves all of
// them. Kept in localStorage, so folds survive a reload and an app restart.
const STORAGE_KEY = 'harness.foldedNodes'
let folded: string[] | null = null
const listeners = new Set<() => void>()

function load(): string[] {
  if (folded) return folded
  folded = []
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved)) folded = saved.filter((id): id is string => typeof id === 'string')
  } catch {
    // Unreadable or blocked storage: start with nothing folded.
  }
  return folded
}

function set(next: string[]): void {
  folded = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the folds still hold until the page reloads.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The actions read the current list, not a value captured at render time.
const actions = {
  fold: (ids: string[]) => set([...new Set([...load(), ...ids])]),
  unfold: (ids: string[]) => set(load().filter((id) => !ids.includes(id))),
}

export function useFoldedNodes() {
  const ids = useSyncExternalStore(subscribe, load)
  return { ids, ...actions }
}
