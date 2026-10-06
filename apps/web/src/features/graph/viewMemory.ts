import type { Viewport } from '@xyflow/react'

/**
 * Each project's graph pan/zoom, so returning to a project (from a chat or from another project)
 * shows it as it was left. `nodeCount` is the number of nodes at that time: the view re-fits when
 * nodes were added or removed since. Kept in memory and in localStorage, so it survives a reload.
 */
export interface RememberedView {
  viewport: Viewport
  nodeCount: number
}

const STORAGE_KEY = 'harness.graphViews'
let views: Map<string, RememberedView> | null = null

function load(): Map<string, RememberedView> {
  if (views) return views
  views = new Map()
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, RememberedView>
    for (const [projectId, view] of Object.entries(saved)) views.set(projectId, view)
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  return views
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(load())))
  } catch {
    // Storage full or blocked: the view is still remembered until the page reloads.
  }
}

export function rememberedView(projectId: string): RememberedView | undefined {
  return load().get(projectId)
}

export function rememberView(projectId: string, view: RememberedView): void {
  load().set(projectId, view)
  save()
}

/** Re-fit the project's view next time (e.g. after "Start over"). */
export function forgetView(projectId: string): void {
  load().delete(projectId)
  save()
}
