import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Render model output (Markdown with tables, lists, code) with readable typography. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-table:block prose-table:overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
