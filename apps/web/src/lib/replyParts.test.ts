import type { ToolCall } from '@harness/shared'
import { describe, expect, it } from 'vitest'
import { replyParts } from './replyParts'

const call = (id: string, offset?: number): ToolCall => ({ id, name: 'web_search', input: id, status: 'done', results: [], offset })

describe('replyParts', () => {
  it('puts tool calls where they ran', () => {
    const text = 'Let me look.\n\nFound it.\n\nDone.'
    const parts = replyParts(text, [call('a', 12), call('b', 12), call('c', 23)])
    expect(parts).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tools', calls: [call('a', 12), call('b', 12)] },
      { kind: 'text', text: '\n\nFound it.' },
      { kind: 'tools', calls: [call('c', 23)] },
      { kind: 'text', text: '\n\nDone.' },
    ])
  })

  it('shows calls without an offset first (older replies)', () => {
    expect(replyParts('Answer.', [call('a'), call('b')])).toEqual([
      { kind: 'tools', calls: [call('a'), call('b')] },
      { kind: 'text', text: 'Answer.' },
    ])
  })

  it('handles calls at the end, no text, and offsets past the text', () => {
    expect(replyParts('Hi', [call('a', 2), call('b', 99)])).toEqual([
      { kind: 'text', text: 'Hi' },
      { kind: 'tools', calls: [call('a', 2), call('b', 99)] },
    ])
    expect(replyParts('', [call('a', 0)])).toEqual([{ kind: 'tools', calls: [call('a', 0)] }])
    expect(replyParts('Only text', [])).toEqual([{ kind: 'text', text: 'Only text' }])
  })
})
