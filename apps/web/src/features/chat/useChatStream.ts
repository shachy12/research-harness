import type { ChatStreamEvent, ToolCall } from '@harness/shared'
import { useEffect, useRef, useState } from 'react'
import { stopReply, streamChat, watchChat } from '@/api/client'
import { useRefreshAll } from '@/api/queries'

export interface StreamState {
  /** The user message being answered (shown until the saved version arrives with the refetch). */
  userText: string | null
  /** The reply so far. */
  replyText: string
  /** Searches and fetches so far, in the order they started. */
  toolCalls: ToolCall[]
  /** The model is reasoning and hasn't produced text yet. */
  thinking: boolean
  active: boolean
  error: string | null
}

const IDLE: StreamState = { userText: null, replyText: '', toolCalls: [], thinking: false, active: false, error: null }

const upsert = (calls: ToolCall[], call: ToolCall) =>
  calls.some((c) => c.id === call.id) ? calls.map((c) => (c.id === call.id ? call : c)) : [...calls, call]

/**
 * Shows one node's reply as it streams. Replies run on the server: `send` starts one, `watch`
 * attaches to one already running (e.g. a branch started by fork), `stop` ends it.
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
        setState((s) => ({ ...s, replyText: event.text, toolCalls: event.toolCalls, thinking: event.thinking }))
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
        setState((s) => ({ ...s, error: event.error }))
        break
    }
  }

  const run = async (userText: string | null, start: (signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    setState({ ...IDLE, userText, active: true })
    try {
      await start(abort.signal)
    } catch (err) {
      if (abort.signal.aborted) return // the page closed; the reply goes on without us
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Sending failed' }))
    }
    await refresh()
    setState((s) => ({ ...IDLE, error: s.error }))
  }

  return {
    ...state,
    send: (content: string) => run(content, (signal) => streamChat(nodeId, content, onEvent, signal)),
    watch: () => run(null, (signal) => watchChat(nodeId, onEvent, signal)),
    stop: () => void stopReply(nodeId),
  }
}
