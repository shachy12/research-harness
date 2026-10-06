import type { DagNode } from '@harness/shared'
import { useDeleteNode } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Confirm, then delete a node. Its children become roots. */
export function DeleteNodeDialog({ node, childCount, running, onDeleted, onClose }: {
  node: DagNode
  /** Nodes that have it as a parent (branches and merges): they become roots. */
  childCount: number
  /** A reply is being written there: deleting stops it. */
  running: boolean
  onDeleted: () => void
  onClose: () => void
}) {
  const remove = useDeleteNode()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete "{node.title}"?</DialogTitle>
          <DialogDescription>
            This deletes its messages{running && ' and stops the reply it is writing'}. A backup of the database is saved
            first (in <code className="text-xs">data/backups/</code>), so it can be recovered if needed. Its file changes
            stay in its git branch.
          </DialogDescription>
        </DialogHeader>
        {childCount > 0 && (
          <p className="rounded-lg border border-merge/40 bg-merge-soft px-3 py-2 text-sm text-merge">
            Its {childCount === 1 ? 'child becomes a separate root' : `${childCount} children become separate roots`}. They
            keep their own conversations, and the model in them still knows what came before, but the graph no longer
            links them here and their chats no longer show this node's messages as inherited context.
          </p>
        )}
        {remove.isError && <p className="text-sm text-destructive">{remove.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} autoFocus>Cancel</Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(node.id, { onSuccess: () => { onDeleted(); onClose() } })}
          >
            {remove.isPending ? 'Deleting…' : 'Delete node'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
