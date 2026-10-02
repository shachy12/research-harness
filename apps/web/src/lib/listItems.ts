import { titleFromPrompt } from '@harness/shared'

/** A list item or table row the user picked in a reply: where it is in the message's Markdown, and its text. */
export interface SelectedItem {
  messageId: string
  /** Offsets of the item in the Markdown that was rendered (marker included). */
  start: number
  end: number
  /** The item as Markdown, without its list marker (a table row: one `Column: cell` line per cell). */
  text: string
  /** The branch title, when it isn't simply the first line of `text` (a table row: its first cell). */
  title?: string
}

export const itemKey = (messageId: string, start: number) => `${messageId}:${start}`

/**
 * The Markdown of one list item without its marker: `- Use a hybrid argument` becomes
 * `Use a hybrid argument`, and the lines under it (a paragraph, a nested list, code) are
 * de-indented by the marker's width so they still read as Markdown.
 */
export function itemSource(markdown: string, start: number, end: number): string {
  const lines = markdown.slice(start, end).split('\n')
  const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(lines[0])
  // The item starts at its marker, but the lines under it also carry the indent of the lists around it.
  const column = start - (markdown.lastIndexOf('\n', start - 1) + 1)
  const width = (marker ? marker[0].length : 0) + column
  const first = lines[0].slice(marker ? marker[0].length : 0).replace(/^\[[ xX]\][ \t]+/, '') // a task-list box is not part of the text
  const rest = lines.slice(1).map((line) => {
    let i = 0
    while (i < width && line[i] === ' ') i++
    return line.slice(i)
  })
  return [first, ...rest].join('\n').trim()
}

/**
 * Ticking an item includes its sub-items, so a ticked item that sits inside another ticked item is
 * not a branch of its own. What is left is in reading order: message order, then position.
 */
export function resolveSelection(items: SelectedItem[], messageOrder: string[]): SelectedItem[] {
  const order = new Map(messageOrder.map((id, i) => [id, i]))
  return items
    .filter((a) => !items.some((b) => b !== a && isInside(a, b)))
    .sort((a, b) => (order.get(a.messageId) ?? 0) - (order.get(b.messageId) ?? 0) || a.start - b.start)
}

/** `a` lies within `b` (same message). Identical ranges never happen: an item is selected once. */
export function isInside(a: Pick<SelectedItem, 'messageId' | 'start' | 'end'>, b: Pick<SelectedItem, 'messageId' | 'start' | 'end'>) {
  return a.messageId === b.messageId && b.start <= a.start && a.end <= b.end && (b.start < a.start || a.end < b.end)
}

/** A branch's first message: the instruction for every branch, with the item placed in `{item}` or after it. */
export function composeBranchPrompt(instruction: string, item: string): string {
  const text = instruction.trim()
  if (!text) return item
  return text.includes('{item}') ? text.replaceAll('{item}', item) : `${text}\n\n${item}`
}

/** A branch title from an item: its first line as plain text (no Markdown marks), shortened. */
export function itemTitle(item: string): string {
  const line =
    item
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  const plain = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images keep their text
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(\S.*?\S|\S)\2(?=$|[\s).,;:!?])/g, '$1$3')
    .replace(/`([^`]*)`/g, '$1')
  return titleFromPrompt(plain || line)
}

/**
 * A section (a heading or bold lead-in line and what follows it) as a branch item: its Markdown as
 * written, titled by its heading without marks or numbering (`**1. Reduce to linear.**` → "Reduce to linear").
 */
export function sectionItem(markdown: string, start: number, end: number): { text: string; title: string } | null {
  const text = markdown.slice(start, end).trim()
  if (!text) return null
  const head = text
    .split('\n')[0]
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+$/, '') // closing hashes of a heading
    .replace(/^(\*\*|__)(.+)\1\s*[:.]?$/, '$2') // a bold lead-in line
    .trim()
    .replace(/^(?:\d{1,3}|[A-Za-z])[.)]\s+/, '') // "1. ", "a) "
    .replace(/[.:]$/, '')
  return { text, title: itemTitle(head || text) }
}

/** Cells of one table row line: split on pipes that are not escaped, outer pipes dropped. */
export function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

const isDelimiterRow = (line: string) => /-/.test(line) && /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line)

/** The header cells of the table whose body row starts at `start`, or null if it can't be found. */
function headerCells(markdown: string, start: number): string[] | null {
  const lines = markdown.slice(0, start).split('\n')
  lines.pop() // the (empty) text before the row on its own line
  for (let i = lines.length - 1; i >= 1; i--) {
    if (isDelimiterRow(lines[i])) return splitRow(lines[i - 1])
    if (!lines[i].includes('|')) return null
  }
  return null
}

/**
 * A table row as a branch item. On its own a row means little (its cells have no column names), so
 * each cell gets its column's header: `Attack: …`, `Idea: …`. The title is the first cell.
 */
export function tableRowItem(markdown: string, start: number, end: number): { text: string; title: string } | null {
  const header = headerCells(markdown, start)
  const cells = splitRow(markdown.slice(start, end)).slice(0, header?.length)
  const lines = cells.flatMap((cell, i) => (cell ? [header?.[i] ? `${header[i]}: ${cell}` : cell] : []))
  if (lines.length === 0) return null
  return { text: lines.join('\n'), title: itemTitle(cells.find(Boolean) ?? lines[0]) }
}
