import type { BranchResult, ContextItem } from '@harness/shared'
import { PaperclipIcon } from 'lucide-react'
import { contextTokens, formatTokens } from '@/lib/tokens'

/**
 * Collapsed summary of what this node inherits; expands to show each item briefly. A merged node's
 * results open to show all of what the model received (read-only).
 */
export function InheritedContext({ items }: { items: ContextItem[] }) {
  if (items.length === 0) return null
  const messages = items.filter((i) => i.kind === 'message').length
  const results = items.length - messages

  return (
    <details className="group rounded-lg border border-dashed bg-muted/40">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted-foreground">
        Inherited context
        <span className="ml-2 font-mono font-normal">
          {messages} messages{results > 0 && ` · ${results} results`} · ~{formatTokens(contextTokens(items))} tokens
        </span>
      </summary>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {items.map((item) =>
          item.kind === 'message' ? (
            <div key={item.message.id} className="text-xs">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                {item.message.role === 'user' ? 'You' : 'Assistant'}
              </span>
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{item.nodeTitle}</span>
              <p className="line-clamp-3 text-foreground/80">{item.message.content}</p>
              {item.message.attachments.length > 0 && (
                <p className="flex items-center gap-1 text-muted-foreground">
                  <PaperclipIcon className="size-3" aria-hidden="true" />
                  {item.message.attachments.map((a) => (a.kind === 'folder' ? `${a.name}/` : a.name)).join(', ')}
                </p>
              )}
            </div>
          ) : (
            <details key={`result-${item.nodeId}`} className="group/result rounded-md bg-done-soft px-2 py-1.5 text-xs">
              <summary className="cursor-pointer">
                <span className="text-[10px] font-semibold tracking-wider text-done uppercase">Result</span>
                <span className="ml-2 font-semibold">{item.nodeTitle}</span>
                <span className="ml-2 text-muted-foreground group-open/result:hidden">(click to read it all)</span>
                <p className="line-clamp-3 text-foreground/80 group-open/result:hidden">{item.result.findings}</p>
              </summary>
              <ResultFields result={item.result} />
            </details>
          ),
        )}
      </div>
    </details>
  )
}

function ResultFields({ result }: { result: BranchResult }) {
  const rows: [string, string][] = [
    ['Findings', result.findings],
    ['Evidence', result.evidence || '—'],
    ['Open', result.openQuestions || '—'],
    ['Confidence', result.confidence],
  ]
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="pt-px text-[10px] font-semibold tracking-wide text-done uppercase">{label}</dt>
          <dd className="break-words whitespace-pre-wrap text-foreground/90">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
