import type { BranchResult, Confidence, DagNode } from '@harness/shared'
import { useEffect, useRef, useState } from 'react'
import { useDraftResult, useSaveResult } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const CONFIDENCE: Confidence[] = ['low', 'medium', 'high']

/**
 * Finish a branch: the model drafts the result, the user edits and approves it.
 * With an existing result (editing a finished branch) no draft is requested.
 */
export function ResultDialog({ node, onClose }: { node: DagNode; onClose: () => void }) {
  const editing = node.result !== null
  const draft = useDraftResult()
  const save = useSaveResult()
  const [result, setResult] = useState<BranchResult | null>(node.result)

  // Request the draft once. (In development React runs effects twice; the ref avoids a second paid call.)
  const requested = useRef(false)
  const requestDraft = draft.mutate
  useEffect(() => {
    if (editing || requested.current) return
    requested.current = true
    requestDraft(node.id, { onSuccess: setResult })
  }, [editing, node.id, requestDraft])

  const set = (field: keyof BranchResult) => (value: string) =>
    setResult((r) => (r ? { ...r, [field]: value } : r))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit result' : 'Finish branch'}: "{node.title}"</DialogTitle>
          <DialogDescription>
            {editing ? '' : 'The model drafts the result from this branch. '}
            Edit it, then approve. Only this result goes back when you merge, not the transcript.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          draft.isError ? (
            <div className="grid gap-3">
              <p className="text-sm text-destructive">{draft.error.message}</p>
              <Button
                variant="outline"
                onClick={() => setResult({ findings: '', evidence: '', openQuestions: '', confidence: 'medium' })}
              >
                Write it by hand
              </Button>
            </div>
          ) : (
            <p className="animate-pulse py-8 text-center text-sm text-muted-foreground">Drafting the result…</p>
          )
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({ nodeId: node.id, result }, { onSuccess: onClose })
            }}
          >
            <Field id="result-findings" label="Findings" rows={5} value={result.findings} onChange={set('findings')} />
            <Field id="result-evidence" label="Evidence and sources" rows={3} value={result.evidence} onChange={set('evidence')} />
            <Field id="result-questions" label="Open questions" rows={2} value={result.openQuestions} onChange={set('openQuestions')} />
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">Confidence</legend>
              <div className="flex gap-2">
                {CONFIDENCE.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    size="sm"
                    variant={result.confidence === c ? 'default' : 'outline'}
                    aria-pressed={result.confidence === c}
                    onClick={() => setResult({ ...result, confidence: c })}
                    className="capitalize"
                  >
                    {c}
                  </Button>
                ))}
              </div>
            </fieldset>
            {save.isError && <p className="text-sm text-destructive">{save.error.message}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending || !result.findings.trim()}>
                {save.isPending ? 'Saving…' : editing ? 'Save result' : 'Approve result'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ id, label, rows, value, onChange }: {
  id: string
  label: string
  rows: number
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
