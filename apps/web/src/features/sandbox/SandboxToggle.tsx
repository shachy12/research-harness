import type { DagNode } from '@harness/shared'
import { LockIcon, LockOpenIcon, Settings2Icon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useProjects, useSandboxStatus, useSetSandboxed } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { sandboxProblem } from './sandbox'
import { SandboxSettingsDialog } from './SandboxSettingsDialog'

/**
 * Secure mode's lock button, by the composer: green "Sandboxed" (the next reply runs in a Docker
 * container that sees only the project, read-only, and this node's copy) or amber "Not
 * sandboxed" (it runs on this machine). Turning it off for a conversation that ran in the sandbox
 * asks first: what ran there may have left instructions in it. While sandboxed, a gear opens the
 * project's sandbox settings, and a warning says what keeps the sandbox from starting.
 */
export function SandboxToggle({ node, untrusted, disabled }: {
  node: DagNode
  /** The conversation has replies written in the sandbox (`NodeDetail.untrusted`). */
  untrusted: boolean
  disabled: boolean
}) {
  const status = useSandboxStatus().data
  const settings = useProjects().data?.find((p) => p.id === node.projectId)?.sandbox
  const save = useSetSandboxed()
  const [confirmOff, setConfirmOff] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Show the change at once, before the refetched node confirms it.
  const on = save.isPending && save.variables ? save.variables.sandboxed : node.sandboxed

  if (status && !status.supported) return null
  const problem = on && status ? sandboxProblem(status, settings) : null

  const toggle = () => {
    if (on && untrusted) setConfirmOff(true)
    else save.mutate({ nodeId: node.id, sandboxed: !on })
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled || save.isPending}
        onClick={toggle}
        title={on
          ? 'Sandboxed: the next reply runs in a Docker container that sees only the project folder (read-only) and this node\'s copy. Click to run it on this machine instead.'
          : 'Not sandboxed: the next reply runs on this machine, where its shell commands can reach your files. Click to run it in a Docker sandbox.'}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors',
          'focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          on
            ? 'border-secure/50 bg-secure-soft text-secure hover:border-secure'
            : 'border-exposed/40 bg-exposed-soft/60 text-exposed hover:border-exposed hover:bg-exposed-soft',
        )}
      >
        {on ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
        {on ? 'Sandboxed' : 'Not sandboxed'}
      </button>
      {on && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Sandbox settings"
          title="Sandbox settings for this project (image, login, folders)"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2Icon className="size-4" />
        </Button>
      )}
      {problem && (
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="inline-flex max-w-64 items-center gap-1 text-left text-xs text-destructive hover:underline"
          title={problem}
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          <span className="truncate">{problem}</span>
        </button>
      )}
      {save.isError && <span className="text-xs text-destructive">{save.error.message}</span>}

      {confirmOff && (
        <Dialog open onOpenChange={(open) => !open && setConfirmOff(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Run "{node.title}" outside the sandbox?</DialogTitle>
              <DialogDescription>
                This conversation (or one it continues) ran in the sandbox, where the model read web pages and files
                that may carry hidden instructions. Outside the sandbox its next reply can run shell commands on this
                machine with your permissions, with those instructions still in its context.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOff(false)} autoFocus>Keep it sandboxed</Button>
              <Button
                variant="destructive"
                onClick={() => save.mutate({ nodeId: node.id, sandboxed: false }, { onSettled: () => setConfirmOff(false) })}
              >
                Run outside the sandbox
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {settingsOpen && <SandboxSettingsDialog projectId={node.projectId} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/** A small lock for graph cards and replies written in the sandbox. */
export function SandboxMark({ className, title = 'Sandboxed: runs in a Docker container' }: { className?: string; title?: string }) {
  return (
    <span className={cn('inline-flex items-center text-secure', className)} title={title} aria-label={title}>
      <LockIcon className="size-3" />
    </span>
  )
}
