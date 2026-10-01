import { useSyncExternalStore } from 'react'

// Which finished nodes are selected for merging. Kept outside the graph component,
// so the selection survives opening a chat and coming back to the graph.
let selected: string[] = []
const listeners = new Set<() => void>()

function set(next: string[]) {
  selected = next
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The actions read the current `selected`, not a value captured at render time.
const actions = {
  toggle: (id: string) => set(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]),
  /** Drop ids that are no longer selectable (deleted, or not finished). */
  keepOnly: (allowed: Set<string>) => {
    if (selected.some((id) => !allowed.has(id))) set(selected.filter((id) => allowed.has(id)))
  },
  clear: () => set([]),
}

export function useMergeSelection() {
  const ids = useSyncExternalStore(subscribe, () => selected)
  return { ids, ...actions }
}
