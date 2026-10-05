import type { Attachment, Role, ToolCall } from '@harness/shared'
import { useMemo } from 'react'
import { prepareMath } from '@/lib/math'
import { replyParts } from '@/lib/replyParts'
import { cn } from '@/lib/utils'
import { AttachmentChip } from './AttachmentChip'
import { Markdown } from './Markdown'
import { ToolCalls } from './ToolCalls'

export function MessageView({ id, role, text, toolCalls = [], attachments = [], streaming }: {
  /** Saved messages carry their id so the chat can scroll to them and track what was read. */
  id?: string
  role: Role
  text: string
  toolCalls?: ToolCall[]
  attachments?: Attachment[]
  streaming?: boolean
}) {
  return (
    <div className="flex min-w-0 scroll-mt-4 flex-col gap-1.5" data-message-id={id}>
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {role === 'user' ? 'You' : 'Assistant'}
      </div>
      {role === 'user' ? (
        <div className="flex flex-col gap-2 rounded-lg bg-open-soft px-3 py-2">
          <div className="break-words whitespace-pre-wrap">{text}</div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <AttachmentChip key={a.path} name={a.name} size={a.size} kind={a.kind} fileCount={a.fileCount} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <ReplyBody id={id} text={text} toolCalls={toolCalls} streaming={streaming} />
          {/* Once this end marker has been on screen, the reply counts as read. */}
          {id && <div data-read-marker={id} aria-hidden="true" />}
        </>
      )}
    </div>
  )
}

/** A reply's text with its tool calls in the places they ran. */
function ReplyBody({ id, text, toolCalls, streaming }: { id?: string; text: string; toolCalls: ToolCall[]; streaming?: boolean }) {
  const parts = useMemo(() => replyParts(text, toolCalls), [text, toolCalls])
  // Where each piece starts among the pieces' rendered text, so items picked for a fork in
  // different pieces never share an offset (only saved replies are pickable).
  const bases = useMemo(
    () =>
      parts.reduce<number[]>((acc, _part, i) => {
        const prev = parts[i - 1]
        const step = i > 0 && id && prev.kind === 'text' ? prepareMath(prev.text).length + 1 : 0
        return [...acc, (acc.at(-1) ?? 0) + step]
      }, []),
    [parts, id],
  )
  const lastText = parts.findLastIndex((p) => p.kind === 'text')
  return parts.map((part, i) =>
    part.kind === 'tools' ? (
      <ToolCalls key={part.calls[0].id} calls={part.calls} />
    ) : (
      <div key={`text-${i}`} className={cn(streaming && i === lastText && i === parts.length - 1 && 'after:animate-pulse after:text-primary after:content-["▍"]')}>
        <Markdown text={part.text} messageId={id} base={bases[i]} />
      </div>
    ),
  )
}
