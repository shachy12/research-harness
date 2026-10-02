import { FolderOpenIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreateProject, usePickFolder } from '@/api/queries'
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
                placeholder="A new folder made by Harness"
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
                  pick.mutate(folder.trim() || undefined, { onSuccess: ({ path }) => path && setFolder(path) })
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
              Leave empty and Harness makes a new folder for it. Or choose an existing folder, such as your LaTeX
              repository: the model can then read the files in it (and only those). Uploads go to a{' '}
              <code>.harness</code> folder inside it. You can't change the folder later.
            </p>
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
