import { MANAGED_DIR } from '@harness/shared'
import { FolderOpenIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useCheckFolder, useCreateProject, usePickFolder } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Start a new project (its own graph, starting from an empty root), then open it. */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const create = useCreateProject()
  const pick = usePickFolder()
  const navigate = useNavigate()
  // Check the folder once typing pauses (a picked folder is checked right away).
  const [checkedFolder, setCheckedFolder] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setCheckedFolder(folder.trim()), 400)
    return () => clearTimeout(timer)
  }, [folder])

  const submit = () => {
    if (!name.trim()) return
    create.mutate(
      { name: name.trim(), folder: folder.trim() || undefined },
      {
        onSuccess: (project) => {
          onClose()
          navigate(`/projects/${project.id}`)
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A separate research graph. Nothing in it touches your other projects.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              maxLength={120}
              placeholder="e.g. Second paper, or Testing"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-folder">Working folder (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="project-folder"
                placeholder="A new folder named after the project"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                autoFocus={false}
                disabled={pick.isPending}
                onClick={() =>
                  pick.mutate(folder.trim() || undefined, {
                    onSuccess: ({ path }) => {
                      if (!path) return
                      setFolder(path)
                      setCheckedFolder(path)
                    },
                  })
                }
              >
                <FolderOpenIcon /> {pick.isPending ? 'Choosing…' : 'Browse…'}
              </Button>
            </div>
            {pick.isPending && (
              <p className="text-xs text-merge">Choose the folder in the dialog. If you don't see it, it may be behind this window.</p>
            )}
            {pick.isError && <p className="text-xs text-destructive">{pick.error.message}</p>}
            <p className="text-xs text-muted-foreground">
              Leave empty and Harness makes a new folder named after the project. Or choose an existing folder, such as your LaTeX
              repository: the model can then read the files in it (and only those). Each node edits its own copy of the
              folder (in <code>{MANAGED_DIR}</code>), and your files change only when you apply a node's changes. You
              can't change the folder later.
            </p>
            <FolderNotice folder={checkedFolder} />
          </div>
          {create.isError && <p className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What creating the project does to the chosen folder in git: a new repository with all its files
 * committed, or the existing repository's branch that nodes' changes are applied to.
 */
function FolderNotice({ folder }: { folder: string }) {
  const check = useCheckFolder(folder)
  if (!folder) return null
  if (check.isPending) return <p className="text-xs text-muted-foreground">Checking the folder…</p>
  if (check.isError) return <p className="text-xs text-destructive">{check.error.message}</p>

  const { repository, branch, uncommitted } = check.data
  const box = 'rounded-lg border px-3 py-2 text-xs'
  if (!repository) {
    return (
      <p role="status" className={`${box} border-merge/40 bg-merge-soft text-merge`}>
        This folder is not a git repository. Creating the project makes it one (<code>git init</code>) and commits{' '}
        <b>all the files in it</b> (except what a <code>.gitignore</code> leaves out) to a new branch <b>{branch}</b>. Nodes
        start from that commit.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className={`${box} text-muted-foreground`}>
        {branch ? (
          <>
            Git repository on branch <b className="text-foreground">{branch}</b>. A node's changes are applied to the branch
            checked out at that time.
          </>
        ) : (
          'Git repository with no branch checked out (detached HEAD). Check out a branch so nodes’ changes can be applied.'
        )}
      </p>
      {uncommitted && (
        <p role="status" className={`${box} border-merge/40 bg-merge-soft text-merge`}>
          It has uncommitted changes. Nodes start from your last commit, so commit first if they should see them.
        </p>
      )}
    </div>
  )
}
