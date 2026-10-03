import type { ProjectSummary } from '@harness/shared'
import { useDeleteProject } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Confirm, then delete a project with its nodes, messages and results. */
export function DeleteProjectDialog({ project, onDeleted, onClose }: {
  project: ProjectSummary
  onDeleted: () => void
  onClose: () => void
}) {
  const remove = useDeleteProject()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete "{project.name}"?</DialogTitle>
          <DialogDescription>
            This deletes its {project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}, with their messages and results.
            A backup of the database is saved first (in <code className="text-xs">data/backups/</code>), so it can be
            recovered if needed. Its folder and files stay on disk.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">To only hide it from the list, archive it instead.</p>
        {remove.isError && <p className="text-sm text-destructive">{remove.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} autoFocus>Cancel</Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(project.id, { onSuccess: () => { onDeleted(); onClose() } })}
          >
            {remove.isPending ? 'Deleting…' : 'Delete project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
