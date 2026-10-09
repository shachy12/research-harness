import { useEffect, useState } from 'react'

/** What the viewer shows: the file's text, its rendered Markdown, or its changes. */
export type ViewerMode = 'file' | 'preview' | 'changes'

/**
 * How the Files view of a node was left, so coming back (from the chat, another node, or after a
 * reload) finds it the same: the open file, the folders opened or closed by hand, the "Changed
 * files only" filter, and the viewer mode last picked (used whenever the file allows it).
 */
export interface FilesViewState {
  file: string | null
  /** Folders opened (true) or closed (false) by hand; the others follow the default. */
  folders: Record<string, boolean>
  changedOnly: boolean
  mode: ViewerMode
}

const STORAGE_KEY = 'harness.filesView'
const DEFAULT: FilesViewState = { file: null, folders: {}, changedOnly: false, mode: 'file' }

function loadAll(): Record<string, Partial<FilesViewState>> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as Record<string, Partial<FilesViewState>>) : {}
  } catch {
    return {} // unreadable or blocked storage: start fresh
  }
}

export function loadFilesView(nodeId: string): FilesViewState {
  const saved = loadAll()[nodeId] ?? {}
  return {
    file: typeof saved.file === 'string' ? saved.file : null,
    folders: saved.folders && typeof saved.folders === 'object' ? saved.folders : {},
    changedOnly: saved.changedOnly === true,
    mode: saved.mode === 'preview' || saved.mode === 'changes' ? saved.mode : 'file',
  }
}

function saveFilesView(nodeId: string, state: FilesViewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadAll(), [nodeId]: state }))
  } catch {
    // Storage full or blocked: the view still works, it just isn't remembered.
  }
}

/** The node's Files view state, saved whenever it changes. */
export function useFilesViewState(nodeId: string) {
  const [state, setState] = useState(() => loadFilesView(nodeId))
  useEffect(() => {
    if (state !== DEFAULT) saveFilesView(nodeId, state)
  }, [nodeId, state])
  const update = (change: Partial<FilesViewState>) => setState((s) => ({ ...s, ...change }))
  return [state, update] as const
}
