import type { BranchResult } from '@harness/shared'
import { Button } from '@/components/ui/button'

export function ResultBlock({ result, onEdit }: { result: BranchResult; onEdit: () => void }) {
  const rows: [string, string][] = [
    ['Findings', result.findings],
    ['Evidence', result.evidence || '—'],
    ['Open', result.openQuestions || '—'],
    ['Confidence', result.confidence],
  ]
  return (
    <section aria-label="Branch result" className="flex flex-col gap-2 rounded-xl border border-done bg-done-soft p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-background/60 px-2 py-0.5 text-[11px] font-semibold text-done">✓ Result</span>
        This is what a merge receives
        <Button size="sm" variant="outline" className="ml-auto" onClick={onEdit}>Edit</Button>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="pt-0.5 text-[11px] font-semibold tracking-wide text-done uppercase">{label}</dt>
            <dd className="break-words whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
