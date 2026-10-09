import type { DagNode, FileChange } from '@harness/shared'
import { CheckIcon, ChevronRightIcon, FilePenIcon } from 'lucide-react'
import { useState } from 'react'
import { useApplyChanges, useNodeChanges } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { splitDiff } from '@/lib/diff'
import { cn } from '@/lib/utils'

const STATUS_LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

/**
 * The files this node's branch changes compared with the project, with their diff, and the step
 * that brings them into the project ("Apply"). Shown for nodes that have an editable copy.
 * The file list starts collapsed (it can be long); the header with the totals and Apply stays.
 */
export function ChangesPanel({ node, version, working }: {
  node: DagNode
  /** Changes after each reply, so the changes are loaded again. */
  version: string
  /** A reply is running: its edits aren't committed yet, so Apply waits. */
  working: boolean
}) {
  const changes = useNodeChanges(node.id, node.gitBranch !== null, version)
  const apply = useApplyChanges()
  const [expanded, setExpanded] = useState(false)
  if (!node.gitBranch) return null

  const data = changes.data
  const diffs = data ? splitDiff(data.diff) : new Map<string, string>()
  const additions = data?.files.reduce((s, f) => s + (f.additions ?? 0), 0) ?? 0
  const deletions = data?.files.reduce((s, f) => s + (f.deletions ?? 0), 0) ?? 0

  return (
    <section aria-label="File changes" className="flex flex-col gap-2 rounded-xl border border-open/40 bg-open-soft/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 font-semibold text-open"
          aria-expanded={expanded}
          title={expanded ? 'Hide the files' : 'Show the files'}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRightIcon className={cn('size-4 transition-transform', expanded && 'rotate-90')} />
          <FilePenIcon className="size-4" /> File changes
        </button>
        {data && data.files.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {data.files.length} {data.files.length === 1 ? 'file' : 'files'} · <span className="text-done">+{additions}</span>{' '}
            <span className="text-destructive">−{deletions}</span>
          </span>
        )}
        <code className="text-[11px] text-muted-foreground" title="This node's git branch">{node.gitBranch}</code>
        {data && data.files.length > 0 && (
          <Button
            size="sm"
            className="ml-auto"
            disabled={working || apply.isPending || data.conflicts.length > 0 || !data.target}
            title={working ? 'Wait for the reply to finish' : undefined}
            onClick={() => apply.mutate(node.id)}
          >
            {apply.isPending ? 'Applying…' : `Apply to ${data.target ?? 'project'}`}
          </Button>
        )}
      </div>

      {changes.isPending && <p className="text-xs text-muted-foreground">Loading changes…</p>}
      {changes.isError && <p className="text-xs text-destructive">Could not load the changes: {changes.error.message}</p>}
      {data === null && <p className="text-xs text-muted-foreground">No file changes yet.</p>}
      {data && data.files.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {data.applied ? <><CheckIcon className="size-3.5 text-done" /> All changes are in {data.target ?? 'the project'}.</> : 'No file changes yet.'}
        </p>
      )}
      {data && !data.target && data.files.length > 0 && (
        <p className="text-xs text-destructive">The project folder is not on a branch (detached HEAD), so nothing can be applied.</p>
      )}
      {data && data.conflicts.length > 0 && (
        <p role="status" className="rounded-lg border border-merge/40 bg-merge-soft px-3 py-2 text-xs text-merge">
          Applying now would conflict with changes in {data.target} to {data.conflicts.join(', ')}. Apply it by hand
          (<code>git merge {node.gitBranch}</code>) or continue in a node that resolves it.
        </p>
      )}
      {data && data.unresolved.length > 0 && (
        <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {data.unresolved.join(', ')} still {data.unresolved.length === 1 ? 'has' : 'have'} conflict markers
          (&lt;&lt;&lt;&lt;&lt;&lt;&lt;) from merging branches. Ask this node to resolve them before applying.
        </p>
      )}
      {apply.isError && <p className="text-xs whitespace-pre-wrap text-destructive">{apply.error.message}</p>}

      {expanded && data && data.files.length > 0 && (
        <div className="flex flex-col gap-1">
          {data.files.map((f) => (
            <details key={f.path} className="group rounded-md border bg-background/70">
              <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs">
                <span className="w-3 shrink-0 font-mono font-semibold text-muted-foreground" title={f.status}>{STATUS_LETTER[f.status]}</span>
                <span className="min-w-0 truncate font-mono" title={f.path}>{f.path}</span>
                <span className="ml-auto shrink-0 font-mono tabular-nums">
                  {f.additions === null ? (
                    <span className="text-muted-foreground">binary</span>
                  ) : (
                    <>
                      <span className="text-done">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
                    </>
                  )}
                </span>
              </summary>
              <DiffView text={diffs.get(f.path)} />
            </details>
          ))}
          {data.truncated && <p className="text-xs text-muted-foreground">The diff is too long to show in full.</p>}
        </div>
      )}
    </section>
  )
}

/** One file's diff. `fill`: take the space it is given (the Files view) instead of a short box. */
export function DiffView({ text, fill = false }: { text: string | undefined; fill?: boolean }) {
  if (!text) return <p className="border-t px-2.5 py-2 text-xs text-muted-foreground">No text diff to show.</p>
  // Skip git's header lines (diff --git, index, ---/+++); start at the first hunk.
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  return (
    <pre className={cn('overflow-auto py-1 font-mono leading-relaxed', fill ? 'h-full text-xs' : 'max-h-96 border-t text-[11px]')}>
      {(start === -1 ? lines : lines.slice(start)).map((line, i) => (
        <div
          key={i}
          className={cn(
            'px-2.5 whitespace-pre',
            line.startsWith('+') && 'bg-done-soft text-done',
            line.startsWith('-') && 'bg-destructive/10 text-destructive',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}
