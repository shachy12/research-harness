import type { ComponentProps, MouseEvent } from 'react'
import { useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { isInside, itemSource, sectionItem, tableRowItem } from '@/lib/listItems'
import { cn } from '@/lib/utils'
import { useListSelection } from './listSelection'

type Built = { text: string; title?: string } | null

/** Clicking these does their own thing, so it doesn't pick the item. */
const INTERACTIVE = 'a, button, input, summary, select, textarea'

/**
 * What a reply's list items and table rows share: click one to pick it for a fork, click again to
 * drop it. Ticking an item also takes its sub-items (they are part of its text), so those count as
 * included. Only the innermost item or row under the pointer reacts, so a click on a sub-item
 * never picks its parent as well.
 *
 * Not a pick: a click that ends a text selection (drag to copy), on a link or button, or the
 * second click of a double-click. That one undoes the first, so selecting a word by double-click
 * leaves the item as it was.
 *
 * With `handle` (a selector), only that part of the element reacts: a section is picked by its heading.
 * `base` is where the rendered Markdown starts in the reply's text (a reply is rendered in pieces
 * between its tool calls), so items of different pieces never share an offset.
 */
function useSelectable(
  messageId: string,
  base: number,
  start: number | undefined,
  end: number | undefined,
  build: () => Built,
  handle?: string,
) {
  const selection = useListSelection()
  const [hover, setHover] = useState(false)
  if (!selection || start === undefined || end === undefined) return null

  const range = { messageId, start: base + start, end: base + end }
  const picked = selection.items.some((i) => i.messageId === messageId && i.start === range.start)
  const included = selection.items.some((i) => isInside(range, i))
  const toggle = () => {
    const item = build()
    if (item) selection.toggle({ ...range, ...item })
  }

  /** The pointer is on this element's own part, not on an item inside it (or, with a handle, off the handle). */
  const ownTarget = (target: Element, element: Element) =>
    target.closest('[data-selectable]') === element && (!handle || target.closest(handle)?.parentElement === element)

  return {
    picked,
    included,
    hover,
    props: {
      'data-selectable': '',
      onPointerOver: (e: React.PointerEvent<HTMLElement>) =>
        setHover(ownTarget(e.target as Element, e.currentTarget)),
      onPointerLeave: () => setHover(false),
      onClick: (e: MouseEvent<HTMLElement>) => {
        const target = e.target as Element
        if (!ownTarget(target, e.currentTarget)) return // belongs to an item inside, or off the handle
        if (target.closest(INTERACTIVE)) return
        if (e.detail === 2) toggle() // undo the first click of a double-click
        else if (e.detail === 1 && !window.getSelection()?.toString()) toggle()
      },
    },
  }
}

/**
 * A list item in a reply. `markdown` is the exact text that was rendered: the offsets in
 * `node.position` refer to it (`base` places it in the reply, see `useSelectable`).
 */
export function SelectableListItem({ node, children, className, messageId, markdown, base, ...rest }: ComponentProps<'li'> &
  ExtraProps & { messageId: string; markdown: string; base: number }) {
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  const s = useSelectable(messageId, base, start, end, () => ({ text: itemSource(markdown, start!, end!) }))
  if (!s) return <li className={className} {...rest}>{children}</li>

  return (
    <li
      {...rest}
      {...s.props}
      title="Click to pick this item for a fork"
      // The highlight is a layer behind the item that reaches left over its marker (the number or bullet).
      className={cn(
        className,
        'relative isolate cursor-pointer before:absolute before:inset-y-0 before:-right-1 before:-left-6 before:-z-10 before:rounded-md before:transition-colors',
        s.picked && !s.included ? 'before:bg-primary/15' : s.hover && 'before:bg-muted',
      )}
    >
      {children}
    </li>
  )
}

/** A body row of a table in a reply; its text is one `Column: cell` line per cell. Header rows aren't pickable. */
export function SelectableTableRow({ node, children, className, messageId, markdown, base, ...rest }: ComponentProps<'tr'> &
  ExtraProps & { messageId: string; markdown: string; base: number }) {
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  const isBodyRow = node?.children.some((c) => c.type === 'element' && c.tagName === 'td')
  const s = useSelectable(messageId, base, isBodyRow ? start : undefined, end, () => tableRowItem(markdown, start!, end!))
  if (!s) return <tr className={className} {...rest}>{children}</tr>

  return (
    <tr
      {...rest}
      {...s.props}
      title="Click to pick this row for a fork"
      className={cn(
        className,
        'cursor-pointer transition-colors',
        s.picked && !s.included ? 'bg-primary/15' : s.hover && 'bg-muted',
      )}
    >
      {children}
    </tr>
  )
}

/**
 * A section of a reply (see `rehypeSections`): a heading or bold lead-in line and what follows it.
 * Clicking the heading picks the whole section; the items inside it stay pickable on their own.
 */
export function SelectableSection({ node, children, className, messageId, markdown, base, ...rest }: ComponentProps<'section'> &
  ExtraProps & { messageId: string; markdown: string; base: number }) {
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  const s = useSelectable(messageId, base, start, end, () => sectionItem(markdown, start!, end!), '[data-section-head]')
  if (!s) return <section className={className} {...rest}>{children}</section>

  return (
    <section
      {...rest}
      {...s.props}
      className={cn(
        className,
        // Like a list item's: a layer behind the section, a little wider than the text.
        'relative isolate before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-md before:transition-colors',
        '[&>[data-section-head]]:cursor-pointer',
        s.picked && !s.included ? 'before:bg-primary/15' : s.hover && 'before:bg-muted',
      )}
    >
      {children}
    </section>
  )
}
