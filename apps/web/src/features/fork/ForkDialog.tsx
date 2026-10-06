import { type Attachment, type DagNode, type ForkProposal, type ModelsResponse, titleFromPrompt } from '@harness/shared'
import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useFork, useModels } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AttachMenu } from '@/features/chat/AttachMenu'
import { PendingAttachments } from '@/features/chat/AttachmentChip'
import { useAttachments } from '@/features/chat/useAttachments'
import { ModelFields } from '@/features/model/ModelFields'
import { type ModelSettings, changesCache } from '@/features/model/modelSettings'
import { composeBranchPrompt } from '@/lib/listItems'
import { formatTokens } from '@/lib/tokens'
import { useDropZone } from '@/lib/useDropZone'
import { cn } from '@/lib/utils'

/** A list item picked in the chat: the branch it becomes starts from its text and is named after it. */
export interface ForkItem {
  text: string
  title: string
}

interface Branch {
  /** Stable id, so removing a branch keeps the others' state. */
  id: number
  /** The list item this branch was made from; null for a branch written by hand. */
  item: ForkItem | null
  /** What the user typed over the message; null: it still follows the shared instruction. */
  edited: string | null
  /** The title the model proposed for it (fork_branches); null: from the item or the message. */
  title: string | null
  /** Finished uploads, reported by the branch's field. */
  attachments: Attachment[]
  uploading: boolean
  /** Starts as the parent's model and effort. */
  settings: ModelSettings
}

let nextId = 0
const newBranch = (settings: ModelSettings, item: ForkItem | null = null): Branch =>
  ({ id: nextId++, item, edited: null, title: null, attachments: [], uploading: false, settings })

/** The branches to start with: one per picked item, one per proposed branch, or one empty one. */
function initialBranches(settings: ModelSettings, items?: ForkItem[], proposal?: ForkProposal): Branch[] {
  if (items?.length) return items.map((item) => newBranch(settings, item))
  if (proposal?.branches.length) {
    return proposal.branches.map((b) => ({ ...newBranch(settings), edited: b.prompt, title: b.title }))
  }
  return [newBranch(settings)]
}

/**
 * Write each branch's first message, optionally with files. Creating the branches sends those
 * messages right away, so all branches start working in parallel; each is titled after its message.
 *
 * With `items` (list items picked in the chat) there is one branch per item. One instruction says
 * what every branch does with its item; each branch's message is that instruction plus its item
 * (the item goes where `{item}` is, if the instruction has it), and can be edited per branch. The
 * branch is named after its item, not after the shared instruction.
 *
 * With `proposal` (branches the model proposed with its fork_branches tool) the fields start with
 * the proposed messages and titles, for the user to edit before starting them.
 */
export function ForkDialog({ node, inheritedTokens, existingBranches, items, proposal, onClose }: {
  node: DagNode
  inheritedTokens: number
  /** Branches the node already has; forking again adds to them. */
  existingBranches: number
  items?: ForkItem[]
  proposal?: ForkProposal
  onClose: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const parentSettings: ModelSettings = { model: node.model, effort: node.effort }
  const [branches, setBranches] = useState<Branch[]>(() => initialBranches(parentSettings, items, proposal))
  // The branches' copies of the files start from the project folder's branch, not this node's copy.
  const [filesFromProject, setFilesFromProject] = useState(false)
  const fork = useFork()
  const catalog = useModels().data
  const navigate = useNavigate()

  const promptOf = (b: Branch) => b.edited ?? (b.item ? composeBranchPrompt(instruction, b.item.text) : '')
  const update = (id: number, change: Partial<Branch>) =>
    setBranches((list) => list.map((b) => (b.id === id ? { ...b, ...change } : b)))
  const filled = branches.filter((b) => promptOf(b).trim())
  const uploading = branches.some((b) => b.uploading)
  const canCreate = filled.length > 0 && !uploading && !fork.isPending
  const create = () => {
    if (!canCreate) return
    fork.mutate(
      {
        nodeId: node.id,
        filesFromProject,
        branches: filled.map((b) => ({
          prompt: promptOf(b).trim(),
          title: b.item?.title ?? b.title ?? undefined,
          attachments: b.attachments,
          // Left out, the server gives the branch its parent's setting.
          ...(b.settings.model !== node.model || b.settings.effort !== node.effort ? b.settings : {}),
        })),
      },
      { onSuccess: () => navigate(`/projects/${node.projectId}`) },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fork "{node.title}"</DialogTitle>
          <DialogDescription>
            {items?.length
              ? `${items.length} selected ${items.length === 1 ? 'item becomes a branch' : 'items become branches'}: each one's first message is your instruction followed by the item.`
              : proposal?.branches.length
                ? 'The branches the model proposed. Edit their first messages, add or remove branches, and attach files a branch should read.'
                : "Write the first message for each new branch, and attach files a branch should read."}
            {` Each branch starts with this node's full context (~${inheritedTokens.toLocaleString()} tokens) and begins working as soon as you create it.`}
            {existingBranches > 0
              ? ` This node already has ${existingBranches} ${existingBranches === 1 ? 'branch; new ones are added next to it.' : 'branches; new ones are added next to them.'}`
              : node.status === 'open' && ' This node stays open: you can keep talking to it, and its branches keep only what it has now.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          {items?.length ? (
            <div className="grid gap-1.5">
              <Label htmlFor="fork-instruction">What should each branch do with its item?</Label>
              <Textarea
                id="fork-instruction"
                autoFocus
                rows={2}
                className="max-h-40 overflow-y-auto"
                placeholder="e.g. Explain this and check whether it works for our construction. Put {item} in the text to place the item there; leave this empty to send each item as it is."
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    create()
                  }
                }}
              />
            </div>
          ) : null}
          {branches.map((branch, i) => (
            <BranchField
              key={branch.id}
              index={i}
              projectId={node.projectId}
              branch={branch}
              prompt={promptOf(branch)}
              catalog={catalog}
              parentSettings={parentSettings}
              contextTokens={inheritedTokens}
              autoFocus={i === 0 && !items?.length}
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
              onClick={() => setBranches((list) => [...list, newBranch(parentSettings)])}
              disabled={branches.length >= 12}
            >
              + Add branch
            </Button>
          </div>
          {catalog?.canEdit && (
            <label className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={filesFromProject}
                onChange={(e) => setFilesFromProject(e.target.checked)}
              />
              <span>
                Start the files from the project folder&apos;s branch
                <span className="block text-xs text-muted-foreground">
                  {filesFromProject
                    ? "The branches keep this node's conversation, but their copies of the files start from the branch checked out in the project folder. File changes made in this node and its ancestors are not in them."
                    : "Off: the branches' copies of the files start from this node's copy, with the changes made in this conversation."}
                </span>
              </span>
            </label>
          )}
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
function BranchField({ index, projectId, branch, prompt, catalog, parentSettings, contextTokens, autoFocus, onChange, onRemove, onSubmit }: {
  index: number
  projectId: string
  branch: Branch
  /** The message as it will be sent (typed, or composed from the instruction and the item). */
  prompt: string
  /** The models to choose from (not shown until loaded). */
  catalog: ModelsResponse | undefined
  parentSettings: ModelSettings
  /** Estimated tokens of the context the branch starts with. */
  contextTokens: number
  autoFocus: boolean
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
        {branch.item && branch.edited !== null && (
          <button
            type="button"
            onClick={() => onChange({ edited: null })}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Reset to the instruction and item
          </button>
        )}
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
          autoFocus={autoFocus}
          rows={2}
          className="max-h-48 overflow-y-auto"
          placeholder="What should this branch research? e.g. Compare the storage costs of the three options"
          value={prompt}
          onChange={(e) => onChange({ edited: e.target.value })}
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
      {prompt.trim() && (
        <span className="truncate text-xs text-muted-foreground">
          Title: {branch.item?.title ?? branch.title ?? titleFromPrompt(prompt)}
        </span>
      )}
      {catalog && (
        <ModelFields
          compact
          value={branch.settings}
          catalog={catalog}
          onChange={(settings) => onChange({ settings })}
          idPrefix={id}
        />
      )}
      {/* Only where a branch with its parent's setting would read the cache (see forkKeepsCache). */}
      {catalog?.forkKeepsCache && changesCache(parentSettings, branch.settings, catalog) && (
        <span role="status" className="text-xs text-merge">
          A different model or effort than its parent: its first reply reads the ~{formatTokens(contextTokens)} tokens of context without the prompt cache.
        </span>
      )}
      {drop.dragging && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-sm font-medium text-primary">
          Drop to attach to branch {index + 1}
        </span>
      )}
    </div>
  )
}
