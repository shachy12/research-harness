import { type DagNode, titleFromPrompt } from '@harness/shared'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFork } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * Write each branch's first message. Creating the branches sends those messages right away,
 * so all branches start working in parallel; each is titled after its message.
 */
export function ForkDialog({ node, inheritedTokens, existingBranches, onClose }: {
  node: DagNode
  inheritedTokens: number
  /** Branches the node already has; forking again adds to them. */
  existingBranches: number
  onClose: () => void
}) {
  const [prompts, setPrompts] = useState([''])
  const fork = useFork()
  const navigate = useNavigate()

  const filled = prompts.map((p) => p.trim()).filter(Boolean)
  const create = () =>
    fork.mutate({ nodeId: node.id, prompts: filled }, { onSuccess: () => navigate(`/projects/${node.projectId}`) })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fork "{node.title}"</DialogTitle>
          <DialogDescription>
            Write the first message for each new branch. Each branch starts with this node's full context
            (~{inheritedTokens.toLocaleString()} tokens) and begins working as soon as you create it.
            {existingBranches > 0
              ? ` This node already has ${existingBranches} ${existingBranches === 1 ? 'branch; new ones are added next to it.' : 'branches; new ones are added next to them.'}`
              : node.status === 'open' && ' After forking, this node is frozen; you can fork it again later to add more branches.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (filled.length) create()
          }}
        >
          {prompts.map((value, i) => (
            <div key={i} className="grid gap-1.5">
              <Label htmlFor={`fork-branch-${i}`}>Branch {i + 1}</Label>
              <Textarea
                id={`fork-branch-${i}`}
                autoFocus={i === 0}
                rows={2}
                placeholder="What should this branch research? e.g. Compare the storage costs of the three options"
                value={value}
                onChange={(e) => setPrompts(prompts.map((p, j) => (j === i ? e.target.value : p)))}
                onKeyDown={(e) => {
                  // Ctrl+Enter creates the branches from any field.
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && filled.length) {
                    e.preventDefault()
                    create()
                  }
                }}
              />
              {value.trim() && (
                <span className="truncate text-xs text-muted-foreground">Title: {titleFromPrompt(value)}</span>
              )}
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrompts([...prompts, ''])} disabled={prompts.length >= 12}>
              + Add branch
            </Button>
          </div>
          {fork.isError && <p className="text-sm text-destructive">{fork.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={fork.isPending || filled.length === 0}>
              {fork.isPending ? 'Starting…' : filled.length > 1 ? `Start ${filled.length} branches` : 'Start branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
