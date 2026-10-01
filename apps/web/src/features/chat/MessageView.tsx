import type { Role } from '@harness/shared'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'

export function MessageView({ role, text, streaming }: { role: Role; text: string; streaming?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {role === 'user' ? 'You' : 'Assistant'}
      </div>
      {role === 'user' ? (
        <div className="rounded-lg bg-open-soft px-3 py-2 break-words whitespace-pre-wrap">{text}</div>
      ) : (
        <div className={cn(streaming && 'after:animate-pulse after:text-primary after:content-["▍"]')}>
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}
