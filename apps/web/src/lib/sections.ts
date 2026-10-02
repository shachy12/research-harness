import type { Element, ElementContent, Root, RootContent } from 'hast'

/**
 * Sections of a reply, so a whole part of it can be picked for a fork. A section starts at:
 * - a heading (`#` … `######`) and runs to the next heading of the same or a higher level, so a `##`
 *   section contains its `###` subsections;
 * - a bold lead-in line, a paragraph that is only bold text (`**1. Reduce to linear.**`), which is
 *   how replies usually number their options. It runs to the next bold lead-in line or any heading.
 * Only the reply's top-level blocks count: a bold line inside a list item starts nothing.
 */
export function rehypeSections() {
  return (tree: Root) => {
    tree.children = sectionize(tree.children)
  }
}

/** Bold lead-in lines rank below every heading. */
const LEAD_IN = 7

const isBlank = (node: RootContent | ElementContent) => node.type === 'text' && !node.value.trim()

function isLeadIn(node: Element): boolean {
  if (node.tagName !== 'p') return false
  const parts = node.children.filter((c) => !isBlank(c))
  const [first, ...rest] = parts
  if (first?.type !== 'element' || first.tagName !== 'strong') return false
  // An optional `:` or `.` after the bold text, nothing else.
  return rest.length === 0 || (rest.length === 1 && rest[0].type === 'text' && /^\s*[:.]\s*$/.test(rest[0].value))
}

function sectionLevel(node: RootContent): number | null {
  if (node.type !== 'element' || !node.position) return null
  const heading = /^h([1-6])$/.exec(node.tagName)
  if (heading) return Number(heading[1])
  return isLeadIn(node) ? LEAD_IN : null
}

function sectionize(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = []
  const open: { level: number; section: Element }[] = []
  /** Every open section ends at least where `node` ends. */
  const extend = (node: RootContent) => {
    if (!node.position || isBlank(node)) return
    for (const { section } of open) section.position!.end = node.position.end
  }

  for (const node of nodes) {
    const level = sectionLevel(node)
    if (level === null) {
      if (open.length) open[open.length - 1].section.children.push(node as ElementContent)
      else out.push(node)
      extend(node)
      continue
    }
    while (open.length && open[open.length - 1].level >= level) open.pop()
    const head = node as Element
    head.properties = { ...head.properties, dataSectionHead: '' }
    const section: Element = {
      type: 'element',
      tagName: 'section',
      properties: {},
      children: [head],
      position: { start: head.position!.start, end: head.position!.end },
    }
    if (open.length) open[open.length - 1].section.children.push(section)
    else out.push(section)
    extend(node)
    open.push({ level, section })
  }
  return out
}
