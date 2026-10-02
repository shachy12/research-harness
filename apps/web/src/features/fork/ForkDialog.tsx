import { type Attachment, type DagNode, titleFromPrompt } from '@harness/shared'
import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useFork } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AttachMenu } from '@/features/chat/AttachMenu'
import { PendingAttachments } from '@/features/chat/AttachmentChip'
import { useAttachments } from '@/features/chat/useAttachments'
import { useDropZone } from '@/lib/useDropZone'
import { cn } from '@/lib/utils'

interface Branch {
  /** Stable id, so removing a branch keeps the others' state. */
  id: number
  prompt: string
  /** Finished uploads, reported by the branch's field. */
  attachments: Attachment[]
  uploading: boolean
}

let nextId = 0
const newBranch = (): Branch => ({ id: nextId++, prompt: '', attachments: [], uploading: false })

/**
 * Write each branch's first message, optionally with files. Creating the branches sends those
 * messages right away, so all branches start working in parallel; each is titled after its message.
 */
export function ForkDialog({ node, inheritedTokens, existingBranches, onClose }: {
  node: DagNode
  inheritedTokens: number
  /** Branches the node already has; forking again adds to them. */
  existingBranches: number
  onClose: () => void
}) {
  const [branches, setBranches] = useState<Branch[]>(() => [newBranch()])
  const fork = useFork()
  const navigate = useNavigate()

  const update = (id: number, change: Partial<Branch>) =>
    setBranches((list) => list.map((b) => (b.id === id ? { ...b, ...change } : b)))
  const filled = branches.filter((b) => b.prompt.trim())
  const uploading = branches.some((b) => b.uploading)
  const canCreate = filled.length > 0 && !uploading && !fork.isPending
  const create = () => {
    if (!canCreate) return
    fork.mutate(
      { nodeId: node.id, branches: filled.map((b) => ({ prompt: b.prompt.trim(), attachments: b.attachments })) },
      { onSuccess: () => navigate(`/projects/${node.projectId}`) },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fork "{node.title}"</DialogTitle>
          <DialogDescription>
            Write the first message for each new branch, and attach files a branch should read. Each branch starts
            with this node's full context (~{inheritedTokens.toLocaleString()} tokens) and begins working as soon as
            you create it.
            {existingBranches > 0
              ? ` This node already has ${existingBranches} ${existingBranches === 1 ? 'branch; new ones are added next to it.' : 'branches; new ones are added next to them.'}`
              : node.status === 'open' && ' After forking, this node is frozen; you can fork it again later to add more branches.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          {branches.map((branch, i) => (
            <BranchField
              key={branch.id}
              index={i}
              projectId={node.projectId}
              branch={branch}
              onChange={(change) => update(branch.id, change)}
              onRemove={branches.length > 1 ? () => setBranches((list) => list.filter((b) => b.id !== branch.id)) : undefined}
              onSubmit={create}
            />
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setBranches((list) => [...list, newBranch()])}
              disabled={branches.length >= 12}
            >
              + Add branch
            </Button>
          </div>
          {fork.isError && <p className="text-sm text-destructive">{fork.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canCreate} title={uploading ? 'Waiting for uploads to finish' : undefined}>
              {fork.isPending ? 'Starting…' : filled.length > 1 ? `Start ${filled.length} branches` : 'Start branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** One branch: its first message and its files (uploaded right away, like in the chat). */
function BranchField({ index, projectId, branch, onChange, onRemove, onSubmit }: {
  index: number
  projectId: string
  branch: Branch
  onChange: (change: Partial<Branch>) => void
  onRemove?: () => void
  onSubmit: () => void
}) {
  const files = useAttachments(projectId)
  const drop = useDropZone(files.addPicked)
  const id = `fork-branch-${branch.id}`

  // Tell the dialog which uploads are ready, so "Start" sends them and waits for the rest.
  const readyKey = files.ready.map((a) => a.path).join('|')
  const report = { attachments: files.ready, uploading: files.uploading }
  useEffect(() => {
    onChange(report)
    // Only when the uploads change (report is rebuilt on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey, files.uploading])

  return (
    <div
      className={cn('relative grid gap-1.5 rounded-lg', drop.dragging && 'outline-2 outline-offset-4 outline-primary outline-dashed')}
      {...drop.props}
    >
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>Branch {index + 1}</Label>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove branch ${index + 1}`}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-start gap-2">
        <AttachMenu onFiles={files.addFiles} onFolders={files.addFolders} />
        <Textarea
          id={id}
          autoFocus={index === 0}
          rows={2}
          placeholder="What should this branch research? e.g. Compare the storage costs of the three options"
          value={branch.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          onKeyDown={(e) => {
            // Ctrl+Enter creates the branches from any field.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
      </div>
      <PendingAttachments files={files.files} onRemove={files.remove} />
      {branch.prompt.trim() && (
        <span className="truncate text-xs text-muted-foreground">Title: {titleFromPrompt(branch.prompt)}</span>
      )}
      {drop.dragging && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-sm font-medium text-primary">
          Drop to attach to branch {index + 1}
        </span>
      )}
    </div>
  )
}
