import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { findMatches, type TextPiece } from '@/lib/textSearch'

/**
 * Find in the chat: Ctrl+F (⌘F on macOS) opens a search box over the conversation, every match is
 * highlighted, Enter / Shift+Enter (or the arrows) go to the next / previous one, Esc closes it.
 *
 * It searches what the chat shows: collapsed parts (tool calls, inherited context) aren't searched
 * until they're opened. Matches are painted with the CSS Custom Highlight API (`::highlight` in
 * index.css), which colours text ranges without changing the page, so React's rendering and the
 * streaming reply are untouched. The search runs again whenever the chat's content changes.
 */
export function ChatSearch({ scrollRef, active }: {
  /** The conversation's scrolling element: what is searched, and what scrolls to a match. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** The chat is on screen (not covered by the Files view). */
  active: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const ranges = useRef<Range[]>([])

  const focusInput = () => requestAnimationFrame(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  const close = () => {
    setOpen(false)
    clearHighlights()
  }

  // Ctrl+F / ⌘F opens the box (or selects its text again); Esc closes it before anything else
  // (the chat's own Esc returns to the graph). Captured, so it runs before the page's handlers.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // Not while the Files view covers the chat, or a dialog is open over it (its Esc closes it).
    if (!active || document.querySelector('[role="dialog"]')) return
    if (isFindShortcut(e)) {
      e.preventDefault()
      setOpen(true)
      focusInput()
    } else if (e.key === 'Escape' && open && !e.defaultPrevented) {
      e.preventDefault()
      close()
    }
  })
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [])

  // Search again: `reveal` (a new query) also goes to the first match at or below the top of the
  // view; otherwise (the content changed) it stays on the same match number.
  const search = useEffectEvent((reveal: boolean) => {
    const root = scrollRef.current
    if (!root || !open) return
    ranges.current = findRanges(root, query)
    setCount(ranges.current.length)
    let index = Math.min(current, Math.max(ranges.current.length - 1, 0))
    if (reveal) {
      const top = root.getBoundingClientRect().top
      const below = ranges.current.findIndex((r) => r.getBoundingClientRect().bottom > top)
      index = Math.max(below, 0)
    }
    setCurrent(index)
    paint(ranges.current, index)
    if (reveal && ranges.current[index]) scrollToRange(root, ranges.current[index])
  })

  useEffect(() => {
    if (open) search(true)
  }, [open, query])

  // A streaming reply, a new message, an opened tool call…: search again (a little later, so a
  // fast stream doesn't search on every word).
  useEffect(() => {
    const root = scrollRef.current
    if (!open || !query.trim() || !root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => search(false), 200)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [open, query, scrollRef])

  useEffect(() => clearHighlights, [])

  const go = (step: number) => {
    const all = ranges.current
    if (all.length === 0) return
    const index = (current + step + all.length) % all.length
    setCurrent(index)
    paint(all, index)
    if (scrollRef.current) scrollToRange(scrollRef.current, all[index])
  }

  if (!open) return null
  return (
    <div
      role="search"
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border bg-card py-1 pr-1 pl-2 shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder="Find in chat"
        aria-label="Find in chat"
        className="w-48 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-16 text-right text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {query.trim() ? (count ? `${current + 1} of ${count}` : 'No results') : ''}
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={count === 0} onClick={() => go(-1)}>
        <ChevronUpIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Next match" title="Next (Enter)" disabled={count === 0} onClick={() => go(1)}>
        <ChevronDownIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close search" title="Close (Esc)" onClick={close}>
        <XIcon />
      </Button>
    </div>
  )
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Ctrl+F, or ⌘F on macOS (where Ctrl+F moves the cursor in text fields). */
function isFindShortcut(e: KeyboardEvent): boolean {
  return (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
}

// What counts as one block of text: a match never runs from one into the next.
const BLOCKS = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, summary, button, dt, dd, div'
// Text that isn't shown as such: KaTeX's copy of each formula for screen readers.
const SKIP = '.katex-mathml, script, style, [data-search-skip]'

/** Ranges of every match of `query` in the visible text under `root`. */
function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return []
  const nodes: Text[] = []
  const pieces: TextPiece[] = []
  const visible = new Map<Element, boolean>()
  const isVisible = (el: Element) => {
    if (!visible.has(el)) visible.set(el, !el.closest(SKIP) && (el.checkVisibility?.() ?? true))
    return visible.get(el)!
  }
  let lastBlock: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement
    if (!node.data || !parent || !isVisible(parent)) continue
    const block = parent.closest(BLOCKS)
    nodes.push(node)
    pieces.push({ text: node.data, newBlock: block !== lastBlock })
    lastBlock = block
  }
  return findMatches(pieces, query).map(({ start, end }) => {
    const range = document.createRange()
    range.setStart(nodes[start.piece], start.offset)
    range.setEnd(nodes[end.piece], end.offset)
    return range
  })
}

const ALL = 'chat-search'
const CURRENT = 'chat-search-current'

function paint(ranges: Range[], current: number): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return // too old a browser: no colours
  CSS.highlights.set(ALL, new Highlight(...ranges.filter((_, i) => i !== current)))
  if (ranges[current]) CSS.highlights.set(CURRENT, new Highlight(ranges[current]))
  else CSS.highlights.delete(CURRENT)
}

function clearHighlights(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** Bring a match into view (a third of the way down), unless it's already well inside it. */
function scrollToRange(scroller: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  if (rect.top >= box.top + 48 && rect.bottom <= box.bottom - 24) return
  scroller.scrollTop += rect.top - box.top - box.height / 3
}
