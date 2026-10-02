import type { ContextItem } from '@harness/shared'
import { PaperclipIcon } from 'lucide-react'
import { contextTokens, formatTokens } from '@/lib/tokens'

/** Collapsed summary of what this node inherits; expands to show each item briefly. */
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
            <div key={`result-${item.nodeId}`} className="rounded-md bg-done-soft px-2 py-1.5 text-xs">
              <span className="text-[10px] font-semibold tracking-wider text-done uppercase">Result</span>
              <span className="ml-2 font-semibold">{item.nodeTitle}</span>
              <p className="line-clamp-3 text-foreground/80">{item.result.findings}</p>
            </div>
          ),
        )}
      </div>
    </details>
  )
}
