import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { prepareMath } from '@/lib/math'
import { SelectableListItem, SelectableTableRow } from './SelectableItem'

const link: Components['a'] = (props) => <a {...props} target="_blank" rel="noreferrer" />

/**
 * Render model output (Markdown with tables, lists, code) with readable typography.
 * Math in $…$ / $$…$$ is typeset with KaTeX; a formula KaTeX can't parse is shown as its source.
 * With a `messageId` (a saved reply), list items and table rows can be clicked to pick them for a fork.
 */
export function Markdown({ text, messageId }: { text: string; messageId?: string }) {
  const prepared = useMemo(() => prepareMath(text), [text])
  // Stable between renders, so ticking an item doesn't remount the whole reply.
  const components = useMemo<Components>(
    () => ({
      a: link,
      ...(messageId && {
        li: (props) => <SelectableListItem {...props} messageId={messageId} markdown={prepared} />,
        tr: (props) => <SelectableTableRow {...props} messageId={messageId} markdown={prepared} />,
      }),
    }),
    [messageId, prepared],
  )
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-table:block prose-table:overflow-x-auto [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={components}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  )
}
