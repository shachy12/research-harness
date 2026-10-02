import type { Attachment, Role, ToolCall } from '@harness/shared'
import { cn } from '@/lib/utils'
import { AttachmentChip } from './AttachmentChip'
import { Markdown } from './Markdown'
import { ToolCalls } from './ToolCalls'

export function MessageView({ role, text, toolCalls = [], attachments = [], streaming }: {
  role: Role
  text: string
  toolCalls?: ToolCall[]
  attachments?: Attachment[]
  streaming?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {role === 'user' ? 'You' : 'Assistant'}
      </div>
      {role === 'user' ? (
        <div className="flex flex-col gap-2 rounded-lg bg-open-soft px-3 py-2">
          <div className="break-words whitespace-pre-wrap">{text}</div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => <AttachmentChip key={a.path} name={a.name} size={a.size} />)}
            </div>
          )}
        </div>
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
