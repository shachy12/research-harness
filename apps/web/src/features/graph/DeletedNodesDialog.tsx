import type { DeletedNode } from '@harness/shared'
import { useRestoreNode } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** The project's deleted nodes, most recent first, each with a Restore button. */
export function DeletedNodesDialog({ deleted, onClose }: { deleted: DeletedNode[]; onClose: () => void }) {
  const restore = useRestoreNode()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deleted nodes</DialogTitle>
          <DialogDescription>
            Restoring a node brings back its messages and attaches its former children again, if they are still roots.
          </DialogDescription>
        </DialogHeader>
        {deleted.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is deleted in this project.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {deleted.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={d.title}>{d.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(d.deletedAt).toLocaleString()} · {d.messageCount} msg
                    {d.childCount > 0 && ` · had ${d.childCount} ${d.childCount === 1 ? 'child' : 'children'}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(d.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
        {restore.isError && <p className="text-sm text-destructive">{restore.error.message}</p>}
      </DialogContent>
    </Dialog>
  )
}
