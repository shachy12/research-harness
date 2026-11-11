import { useState } from 'react'
import { useBranches, useNewRoot } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { BranchInput } from './BranchInput'

/**
 * A new root: another independent conversation in the project (same folder, no shared context),
 * working against a git branch of the project. An existing branch is used as it is; a new name
 * is created from another branch. Apply on the root and everything forked from it merges into that
 * branch, and the root's files start from the branch's latest commit when it gets its first message.
 */
export function NewRootDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const branches = useBranches(projectId)
  const newRoot = useNewRoot(projectId)
  const current = branches.data?.current ?? null
  const existing = branches.data?.branches ?? []
  // Starts with the checked-out branch once the list is in (until the user types something).
  const [typed, setTyped] = useState<string | null>(null)
  const [fromTyped, setFromTyped] = useState<string | null>(null)
  const branch = (typed ?? current ?? '').trim()
  const from = (fromTyped ?? current ?? '').trim()
  const isNew = branch !== '' && branches.isSuccess && !existing.includes(branch)
  const fromMissing = isNew && from !== '' && !existing.includes(from)
  const canCreate = branches.isSuccess && !newRoot.isPending && !fromMissing

  const create = () => {
    if (!canCreate) return
    newRoot.mutate(
      branch ? { branch, ...(isNew && from ? { from } : {}) } : {},
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New root</DialogTitle>
          <DialogDescription>
            Another independent conversation in this project: same folder, no shared context. It and everything
            forked from it work against the git branch below: Apply merges into it, and the root&apos;s files start
            from its latest commit when you send the first message.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="new-root-branch">Git branch</Label>
            <BranchInput
              id="new-root-branch"
              autoFocus
              value={typed ?? current ?? ''}
              branches={existing}
              placeholder={current ? `The checked-out branch (${current})` : 'The checked-out branch'}
              onChange={setTyped}
            />
            <span className="text-xs text-muted-foreground">
              {branches.isPending
                ? 'Reading the branches…'
                : branches.isError
                  ? `Could not read the branches: ${branches.error.message}`
                  : branch === ''
                    ? 'Empty: it follows whichever branch the project folder has checked out at the time.'
                    : isNew
                      ? `"${branch}" doesn't exist yet: it is created now.`
                      : `An existing branch${branch === current ? ' (checked out in the project folder)' : ''}.`}
            </span>
          </div>
          {isNew && (
            <div className="grid gap-1.5">
              <Label htmlFor="new-root-from">Create it from</Label>
              <BranchInput
                id="new-root-from"
                value={fromTyped ?? current ?? ''}
                branches={existing}
                placeholder="The project folder's current commit"
                invalid={fromMissing}
                onChange={setFromTyped}
              />
              {fromMissing && <span className="text-xs text-destructive">There is no branch "{from}".</span>}
            </div>
          )}
          {newRoot.isError && <p className="text-sm text-destructive">{newRoot.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canCreate}>
              {newRoot.isPending ? 'Creating…' : isNew ? 'Create branch and root' : 'Create root'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
