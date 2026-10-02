import { type Message, firstUnreadIndex } from '@harness/shared'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useMarkRead } from '@/api/queries'

/** How close to the end counts as "at the bottom" (px). */
const BOTTOM_SLACK = 80

const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK

/**
 * Scrolling and "what have I read" for one node's chat. Use it in a component that exists once per
 * node (the chat is keyed by node id), because the opening position is decided only once.
 *
 *  - Opening: a node that was never opened starts at the top; one with unread replies starts at the
 *    first unread reply; one that is all read starts at the end.
 *  - Reading: a reply counts as read once its end has been on screen. The server only moves the
 *    read position forward.
 *  - Following: while a reply streams, the view follows it only if you were already at the bottom.
 *    Call `followNext()` after sending a message to jump to the bottom.
 *
 * Attach `scrollRef` to the scrolling element and `endRef` to a marker at the end of the content.
 * `contentKey` is anything that changes when content grows (so the view follows it).
 */
export function useChatScroll({ nodeId, messages, readUpto, contentKey }: {
  nodeId: string
  messages: Message[]
  readUpto: string | null
  contentKey: readonly unknown[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const markRead = useMarkRead()

  // Opening position (once). Runs before paint, so the page never shows the wrong spot first.
  const initial = useRef({ messages, readUpto })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const { messages: opened, readUpto: upto } = initial.current
    const unread = firstUnreadIndex(opened, upto)
    if (upto === null) {
      el.scrollTop = 0
    } else if (unread >= 0) {
      el.querySelector(`[data-message-id="${opened[unread].id}"]`)?.scrollIntoView({ block: 'start' })
    } else {
      endRef.current?.scrollIntoView({ block: 'end' })
    }
    following.current = atBottom(el)
  }, [])

  const onScroll = () => {
    if (scrollRef.current) following.current = atBottom(scrollRef.current)
  }

  // New content (a message, streamed text, a tool call): follow it only if the user is at the bottom.
  useLayoutEffect(() => {
    if (following.current) endRef.current?.scrollIntoView({ block: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run exactly when the content changes
  }, contentKey)

  // Mark replies read once their end marker has been on screen.
  const readIndex = useRef(readUpto === null ? -1 : messages.findIndex((m) => m.id === readUpto))
  const latest = useRef(messages)
  latest.current = messages
  const messageKey = messages.map((m) => m.id).join()
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const visible = new Set<string>()
    const flush = () => {
      if (document.hidden) return // not looking at it
      const ids = latest.current.map((m) => m.id)
      const newest = Math.max(-1, ...[...visible].map((id) => ids.indexOf(id)))
      if (newest <= readIndex.current) return
      readIndex.current = newest
      markRead.mutate({ nodeId, messageId: ids[newest] })
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.readMarker!
          if (e.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        flush()
      },
      { root: el },
    )
    el.querySelectorAll('[data-read-marker]').forEach((m) => observer.observe(m))
    document.addEventListener('visibilitychange', flush)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead.mutate is stable enough; rebuild when the messages change
  }, [nodeId, messageKey])

  return {
    scrollRef,
    endRef,
    onScroll,
    followNext: () => {
      following.current = true
    },
  }
}
