import type { ToolCall } from '@harness/shared'

export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: ToolCall[] }

/**
 * A reply as it happened: its text cut where tool calls ran, with each run of calls in its place.
 * Calls without an `offset` (replies saved before it was recorded) come first, as they used to.
 * Cuts fall where the model started a new text block, so each piece is whole Markdown.
 */
export function replyParts(text: string, calls: ToolCall[]): ReplyPart[] {
  const at = (call: ToolCall) => Math.min(Math.max(call.offset ?? 0, 0), text.length)
  const sorted = calls.map((call, i) => ({ call, i })).sort((a, b) => at(a.call) - at(b.call) || a.i - b.i)
  const parts: ReplyPart[] = []
  let pos = 0
  for (const { call } of sorted) {
    const cut = at(call)
    if (cut > pos) {
      const piece = text.slice(pos, cut)
      if (piece.trim()) parts.push({ kind: 'text', text: piece })
      pos = cut
    }
    const last = parts.at(-1)
    if (last?.kind === 'tools') last.calls.push(call)
    else parts.push({ kind: 'tools', calls: [call] })
  }
  const rest = text.slice(pos)
  if (rest.trim()) parts.push({ kind: 'text', text: rest })
  return parts
}
