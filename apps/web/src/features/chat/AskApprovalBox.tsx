import type { AskApproval } from '@harness/shared'
import { MessageCircleQuestionMarkIcon } from 'lucide-react'
import { useDecideAsks } from '@/api/queries'
import { Button } from '@/components/ui/button'

/**
 * The reply used its free ask_node questions and waits: allow the waiting questions (which frees
 * the usual number again) or deny them. Without an answer in time, the model is told you're away.
 */
export function AskApprovalBox({ nodeId, approval }: { nodeId: string; approval: AskApproval }) {
  const decide = useDecideAsks()
  const n = approval.asks.length
  const until = new Date(approval.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-merge/50 bg-merge-soft/60 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 font-medium text-merge">
        <MessageCircleQuestionMarkIcon className="size-4" aria-hidden="true" />
        The model wants to ask {n === 1 ? 'another node' : `other nodes ${n} more questions`}
      </div>
      <p className="text-muted-foreground">
        {approval.limit > 0
          ? `It used the ${approval.limit} free ${approval.limit === 1 ? 'question' : 'questions'} of this reply.`
          : 'Every question needs your approval (HARNESS_ASK_LIMIT is 0).'}
        {' '}Each question re-reads that node's conversation, which uses your Claude usage limit.
        {approval.limit > 0 && ` Allowing starts the count again: ${approval.limit} free, these included.`}
      </p>
      <ul className="flex flex-col gap-1">
        {approval.asks.map((a, i) => (
          <li key={i} className="rounded-md bg-background/70 px-2 py-1">
            <span className="font-medium">"{a.nodeTitle}"</span>
            {a.from && <span className="text-muted-foreground"> (asked by "{a.from}")</span>}: {a.question}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ nodeId, allow: true })}>
          Allow
        </Button>
        <Button size="sm" variant="outline" className="bg-background" disabled={decide.isPending} onClick={() => decide.mutate({ nodeId, allow: false })}>
          Deny
        </Button>
        <span className="text-xs text-muted-foreground">
          No answer by {until}: the model is told you're away and stops.
        </span>
      </div>
      {decide.isError && <p className="text-destructive">{decide.error.message}</p>}
    </div>
  )
}
