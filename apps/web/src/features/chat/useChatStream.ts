import type { Attachment, ChatStreamEvent, ErrorKind, ToolCall } from '@harness/shared'
import { useEffect, useRef, useState } from 'react'
import { stopReply, streamChat, watchChat } from '@/api/client'
import { useRefreshAll } from '@/api/queries'

/** Why the reply failed; `kind` and `resetsAt` say more when the server knows (e.g. the usage limit). */
export interface StreamError {
  message: string
  kind?: ErrorKind
  resetsAt?: string | null
}

export interface StreamState {
  /** The user message being answered (shown until the saved version arrives with the refetch). */
  userText: string | null
  /** The reply so far. */
  replyText: string
  /** Searches and fetches so far, in the order they started. */
  toolCalls: ToolCall[]
  /** The model is reasoning and hasn't produced text yet. */
  thinking: boolean
  /** When the reply started (from the server when attaching; now when sending). */
  startedAt: string | null
  /**
   * How many saved messages the page had when this reply started. The streamed copies are shown
   * while the saved list still has that many; once the refetch adds the reply, they give way.
   */
  baseline: number
  active: boolean
  error: StreamError | null
}

const IDLE: StreamState = {
  userText: null, replyText: '', toolCalls: [], thinking: false, startedAt: null, baseline: -1, active: false, error: null,
}

const upsert = (calls: ToolCall[], call: ToolCall) =>
  calls.some((c) => c.id === call.id) ? calls.map((c) => (c.id === call.id ? call : c)) : [...calls, call]

/**
 * Shows one node's reply as it streams. Replies run on the server: `send` starts one, `attach`
 * watches one already running (e.g. a branch started by fork), `stop` ends it.
 * Leaving the page only stops watching.
 */
export function useChatStream(nodeId: string) {
  const [state, setState] = useState<StreamState>(IDLE)
  const abortRef = useRef<AbortController | null>(null)
  const refresh = useRefreshAll()

  // Stop watching when the page closes.
  useEffect(() => () => abortRef.current?.abort(), [])

  const onEvent = (event: ChatStreamEvent) => {
    switch (event.type) {
      case 'snapshot':
        setState((s) => ({
          ...s, replyText: event.text, toolCalls: event.toolCalls, thinking: event.thinking, startedAt: event.startedAt,
        }))
        break
      case 'thinking':
        setState((s) => ({ ...s, thinking: true }))
        break
      case 'delta':
        setState((s) => ({ ...s, thinking: false, replyText: s.replyText + event.text }))
        break
      case 'tool':
        setState((s) => ({ ...s, thinking: false, toolCalls: upsert(s.toolCalls, event.call) }))
        break
      case 'error':
        setState((s) => ({ ...s, error: { message: event.error, kind: event.kind, resetsAt: event.resetsAt } }))
        break
    }
  }

  /** Start watching (the previous watch, if any, is dropped). The controller is set synchronously. */
  const run = async (userText: string | null, baseline: number, start: (signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    setState({ ...IDLE, userText, baseline, startedAt: userText ? new Date().toISOString() : null, active: true })
    try {
      await start(abort.signal)
    } catch (err) {
      if (abort.signal.aborted) return // this watch was dropped; the reply goes on without it
      setState((s) => ({ ...s, error: { message: err instanceof Error ? err.message : 'Sending failed' } }))
    }
    if (abort.signal.aborted) return
    await refresh()
    setState((s) => ({ ...IDLE, error: s.error }))
  }

  return {
    ...state,
    /** `messageCount`: saved messages before this one (see `baseline`). */
    send: (content: string, attachments: Attachment[], messageCount: number) =>
      run(content, messageCount, (signal) => streamChat(nodeId, content, attachments, onEvent, signal)),
    /**
     * Watch a reply that is already running. Returns a function that stops watching, for use as an
     * effect cleanup (React may mount a page twice in development; each mount needs its own watch).
     */
    attach: (messageCount: number) => {
      void run(null, messageCount, (signal) => watchChat(nodeId, onEvent, signal))
      const mine = abortRef.current
      return () => mine?.abort()
    },
    stop: () => void stopReply(nodeId),
    /** Forget the last error (e.g. when retrying). */
    clearError: () => setState((s) => ({ ...s, error: null })),
  }
}
