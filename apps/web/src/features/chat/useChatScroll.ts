import { type Message, firstUnreadIndex } from '@harness/shared'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useMarkRead } from '@/api/queries'

/**
 * Scrolling and "what have I read" for one node's chat. Use it in a component that exists once per
 * node (the chat is keyed by node id), because the opening position is decided only once.
 *
 *  - Opening: a node that was never opened starts at the top; one with unread replies starts at the
 *    first unread reply; one that is all read starts at the end.
 *  - Reading: a reply counts as read once its end has been on screen. The server only moves the
 *    read position forward.
 *  - No following: a streaming reply never moves the view, so you can read it as it is written.
 *    Call `pinNext()` before sending a message: the view then brings your message to the top once
 *    (blank space under the reply makes room until it fills a screen) and the reply flows in below
 *    it. Scrolling yourself ends the pin.
 *
 * Attach `scrollRef` to the scrolling element and `endRef` to an empty element at the end of the
 * content (it becomes that spacer). `contentKey` is anything that changes when content grows.
 */
export function useChatScroll({ nodeId, messages, readUpto, contentKey }: {
  nodeId: string
  messages: Message[]
  readUpto: string | null
  contentKey: readonly unknown[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // After sending: keep bringing your newest message up to the top. `setTop` is where we last
  // scrolled to, so a scroll event elsewhere is the user's own and ends the pin.
  const pinned = useRef(false)
  const setTop = useRef<number | null>(null)
  const sent = useRef(false) // a message was sent from this view (the spacer is only for that)
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
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (el && pinned.current && setTop.current !== null && Math.abs(el.scrollTop - setTop.current) > 1) {
      pinned.current = false
    }
  }

  // New content (your message, streamed text, a tool call): only a pinned message moves the view.
  // Until the reply fills a screen, `endRef` grows into a blank spacer under it, so your message can
  // go to the top at once and the view doesn't creep up as the reply comes in. The spacer shrinks as
  // the reply grows (the content above the view never changes, so nothing you read moves).
  useLayoutEffect(() => {
    const el = scrollRef.current
    const end = endRef.current
    if (!el || !end || !sent.current) return
    const mine = el.querySelectorAll('[data-role="user"]')
    const last = mine[mine.length - 1]
    if (!last) return
    const below = end.getBoundingClientRect().top - last.getBoundingClientRect().top
    end.style.height = `${Math.max(0, el.clientHeight - below)}px`
    if (!pinned.current) return
    last.scrollIntoView({ block: 'start' })
    setTop.current = el.scrollTop
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
    pinNext: () => {
      sent.current = true
      pinned.current = true
      setTop.current = null
    },
  }
}
