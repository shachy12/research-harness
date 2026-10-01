import type { ApiError, ChatStreamEvent } from '@harness/shared'

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ApiError | null
    throw new Error(data?.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, signal),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
}

/** Send a message and watch the reply as it streams in. */
export function streamChat(nodeId: string, content: string, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal) {
  return readEvents(
    fetch(`/api/nodes/${nodeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    }),
    onEvent,
  )
}

/** Watch a reply that is already running on the server (starts with a `snapshot`, or `idle`). */
export function watchChat(nodeId: string, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal) {
  return readEvents(fetch(`/api/nodes/${nodeId}/stream`, { signal }), onEvent)
}

/** Stop the running reply; what arrived so far is kept. */
export const stopReply = (nodeId: string) => api.post(`/nodes/${nodeId}/stop`)

/**
 * Read server-sent events: lines of `data: {json}` separated by blank lines.
 * Aborting the signal only stops watching; the reply keeps running on the server.
 */
async function readEvents(response: Promise<Response>, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
  const res = await response
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as ApiError | null
    throw new Error(data?.error ?? `Request failed (${res.status})`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? '' // keep an incomplete event for the next chunk
    for (const raw of events) {
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) onEvent(JSON.parse(data) as ChatStreamEvent)
    }
  }
}
