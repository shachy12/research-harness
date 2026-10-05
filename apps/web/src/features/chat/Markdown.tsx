import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { prepareMath } from '@/lib/math'
import { rehypeSections } from '@/lib/sections'
import { SelectableListItem, SelectableSection, SelectableTableRow } from './SelectableItem'

const KATEX: [typeof rehypeKatex, { throwOnError: boolean; strict: boolean }] = [rehypeKatex, { throwOnError: false, strict: false }]

const link: Components['a'] = (props) => <a {...props} target="_blank" rel="noreferrer" />

/**
 * Render model output (Markdown with tables, lists, code) with readable typography.
 * Math in $…$ / $$…$$ is typeset with KaTeX; a formula KaTeX can't parse is shown as its source.
 * With a `messageId` (a saved reply), list items, table rows and sections (a heading or bold lead-in
 * line and what follows it) can be clicked to pick them for a fork. `base` is where `text` starts in
 * the reply (a reply is rendered in pieces between its tool calls).
 */
export function Markdown({ text, messageId, base = 0 }: { text: string; messageId?: string; base?: number }) {
  const prepared = useMemo(() => prepareMath(text), [text])
  // Stable between renders, so ticking an item doesn't remount the whole reply.
  const components = useMemo<Components>(
    () => ({
      a: link,
      ...(messageId && {
        li: (props) => <SelectableListItem {...props} messageId={messageId} markdown={prepared} base={base} />,
        tr: (props) => <SelectableTableRow {...props} messageId={messageId} markdown={prepared} base={base} />,
        section: (props) => <SelectableSection {...props} messageId={messageId} markdown={prepared} base={base} />,
      }),
    }),
    [messageId, prepared, base],
  )
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-table:block prose-table:overflow-x-auto [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={messageId ? [rehypeSections, KATEX] : [KATEX]}
        components={components}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  )
}
