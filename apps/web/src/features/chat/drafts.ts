import type { Attachment } from '@harness/shared'
import { useSyncExternalStore } from 'react'

/**
 * What was written in each node's composer and not sent yet: the text and the files already
 * uploaded for it. Kept outside the chat page, so leaving a node and coming back finds it as it
 * was, and in localStorage, so it also survives a reload or an app restart. A node without an
 * unsent text or file has no entry.
 */
export interface Draft {
  text: string
  files: Attachment[]
}

const STORAGE_KEY = 'harness.drafts'
const EMPTY: Draft = { text: '', files: [] }
let drafts: Record<string, Draft> | null = null
const listeners = new Set<() => void>()

function load(): Record<string, Draft> {
  if (drafts) return drafts
  drafts = {}
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Partial<Draft>>
    for (const [nodeId, d] of Object.entries(saved)) {
      const draft = { text: typeof d.text === 'string' ? d.text : '', files: Array.isArray(d.files) ? d.files : [] }
      if (!isEmpty(draft)) drafts[nodeId] = draft
    }
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  return drafts
}

function isEmpty(d: Draft): boolean {
  return d.text.trim() === '' && d.files.length === 0
}

// Saved on every change (not debounced): a draft is a few KB at most, and closing the window
// right after typing must not lose the last words.
function update(nodeId: string, change: Partial<Draft>): void {
  const all = load()
  const next = { ...(all[nodeId] ?? EMPTY), ...change }
  // A new object each time, so useSyncExternalStore sees the change.
  const { [nodeId]: _old, ...rest } = all
  drafts = isEmpty(next) ? rest : { ...rest, [nodeId]: next }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Storage full or blocked: the draft is still kept until the page reloads.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Read and change the unsent draft of one node. */
export function useDraft(nodeId: string) {
  const draft = useSyncExternalStore(subscribe, () => load()[nodeId] ?? EMPTY)
  return {
    text: draft.text,
    setText: (text: string) => update(nodeId, { text }),
    clear: () => update(nodeId, EMPTY),
  }
}

/** Every node with an unsent draft (for the "Draft" mark on graph cards). */
export function useDrafts(): Record<string, Draft> {
  return useSyncExternalStore(subscribe, load)
}

/**
 * Keep a node's draft attachments in step with its composer. Built from the draft as it is now
 * and changed through the store, so an upload that finishes after the chat closed is still kept.
 */
export function keepDraftFiles(nodeId: string) {
  const files = () => load()[nodeId]?.files ?? []
  return {
    initial: files(),
    onAdded: (a: Attachment) => update(nodeId, { files: [...files().filter((f) => f.path !== a.path), a] }),
    onRemoved: (a: Attachment) => update(nodeId, { files: files().filter((f) => f.path !== a.path) }),
  }
}
