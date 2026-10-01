import type { Role, ToolCall } from '@harness/shared'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'
import { ToolCalls } from './ToolCalls'

export function MessageView({ role, text, toolCalls = [], streaming }: {
  role: Role
  text: string
  toolCalls?: ToolCall[]
  streaming?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {role === 'user' ? 'You' : 'Assistant'}
      </div>
      {role === 'user' ? (
        <div className="rounded-lg bg-open-soft px-3 py-2 break-words whitespace-pre-wrap">{text}</div>
      ) : (
        <>
          <ToolCalls calls={toolCalls} />
          {text && (
            <div className={cn(streaming && 'after:animate-pulse after:text-primary after:content-["▍"]')}>
              <Markdown text={text} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
