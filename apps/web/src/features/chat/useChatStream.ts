import type { ToolCall } from '@harness/shared'
import { useRef, useState } from 'react'
import { streamChat } from '@/api/client'
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
 * Sends a message to one node and tracks the streaming reply.
 * Leaving the page does not stop the reply: the server finishes and saves it.
 */
export function useChatStream(nodeId: string) {
  const [state, setState] = useState<StreamState>(IDLE)
  const abortRef = useRef<AbortController | null>(null)
  const refresh = useRefreshAll()

  const send = async (content: string) => {
    const abort = new AbortController()
    abortRef.current = abort
    setState({ ...IDLE, userText: content, active: true })
    try {
      await streamChat(
        nodeId,
        content,
        (event) => {
          if (event.type === 'thinking') setState((s) => ({ ...s, thinking: true }))
          else if (event.type === 'delta') setState((s) => ({ ...s, thinking: false, replyText: s.replyText + event.text }))
          else if (event.type === 'tool') setState((s) => ({ ...s, thinking: false, toolCalls: upsert(s.toolCalls, event.call) }))
          else if (event.type === 'error') setState((s) => ({ ...s, error: event.error }))
        },
        abort.signal,
      )
    } catch (err) {
      if (!abort.signal.aborted) setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Sending failed' }))
    }
    await refresh()
    setState((s) => ({ ...IDLE, error: s.error }))
  }

  const stop = () => abortRef.current?.abort()

  return { ...state, send, stop }
}
