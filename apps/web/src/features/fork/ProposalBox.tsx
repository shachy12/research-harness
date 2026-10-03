import { type ForkProposal, titleFromPrompt } from '@harness/shared'
import { GitForkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Branches the model proposed in a reply (its fork_branches tool). Nothing is created until the
 * user opens them in the fork dialog, edits them if needed, and starts them.
 */
export function ProposalBox({ proposal, disabled, onReview }: {
  proposal: ForkProposal
  disabled: boolean
  onReview: () => void
}) {
  const n = proposal.branches.length
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-open/40 bg-open-soft/50 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 font-medium text-open">
        <GitForkIcon className="size-4" aria-hidden="true" />
        Proposed {n === 1 ? 'branch' : `${n} branches`}
      </div>
      <ol className="ml-5 list-decimal text-foreground/90">
        {proposal.branches.map((b, i) => (
          <li key={i} className="truncate" title={b.prompt}>{b.title ?? titleFromPrompt(b.prompt)}</li>
        ))}
      </ol>
      <div>
        <Button size="sm" variant="outline" className="bg-background" disabled={disabled} onClick={onReview}>
          Review and start…
        </Button>
      </div>
    </div>
  )
}
