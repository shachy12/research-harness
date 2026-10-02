import { useResetProject } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Confirm, then delete every node and message in the project, leaving a fresh root. */
export function ResetDialog({ projectId, nodeCount, onDone, onClose }: {
  projectId: string
  nodeCount: number
  onDone: () => void
  onClose: () => void
}) {
  const reset = useResetProject(projectId)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start over?</DialogTitle>
          <DialogDescription>
            This deletes all {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'} in this project, with their messages and
            results, and leaves an empty starting node. A backup of the database is saved first (in{' '}
            <code className="text-xs">data/backups/</code>), so it can be recovered if needed.
          </DialogDescription>
        </DialogHeader>
        {reset.isError && <p className="text-sm text-destructive">{reset.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} autoFocus>Cancel</Button>
          <Button
            variant="destructive"
            disabled={reset.isPending}
            onClick={() => reset.mutate(undefined, { onSuccess: () => { onDone(); onClose() } })}
          >
            {reset.isPending ? 'Deleting…' : 'Delete everything'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
