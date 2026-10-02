import { firstUnreadIndex, unreadCount } from '@harness/shared'
import { describe, expect, it } from 'vitest'

const m = (id: string, role: 'user' | 'assistant') => ({ id, role })
const chat = [m('u1', 'user'), m('a1', 'assistant'), m('u2', 'user'), m('a2', 'assistant'), m('u3', 'user')]

describe('unread replies', () => {
  it('counts every reply when nothing was read', () => {
    expect(unreadCount(chat, null)).toBe(2)
    expect(firstUnreadIndex(chat, null)).toBe(1)
  })

  it('only looks after the last message read', () => {
    expect(unreadCount(chat, 'a1')).toBe(1)
    expect(firstUnreadIndex(chat, 'a1')).toBe(3)
    expect(firstUnreadIndex(chat, 'u2')).toBe(3)
  })

  it('finds nothing when all replies were read (a trailing user message is not a reply)', () => {
    expect(unreadCount(chat, 'a2')).toBe(0)
    expect(firstUnreadIndex(chat, 'a2')).toBe(-1)
    expect(firstUnreadIndex([], null)).toBe(-1)
  })
})
