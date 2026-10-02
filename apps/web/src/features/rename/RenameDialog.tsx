import type { DagNode } from '@harness/shared'
import { SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import { useRename, useSuggestTitle } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/** Rename a node. A title you choose is kept: the model never replaces it. */
export function RenameDialog({ node, onClose }: { node: DagNode; onClose: () => void }) {
  const [title, setTitle] = useState(node.title)
  const rename = useRename()
  const suggest = useSuggestTitle()
  const trimmed = title.trim()

  const save = () => {
    if (!trimmed || trimmed === node.title) return onClose()
    rename.mutate({ nodeId: node.id, title: trimmed }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rename node</DialogTitle>
          <DialogDescription>
            Your title is kept from now on. The model's context doesn't change: it still knows this branch by
            what it was asked.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div className="flex gap-2">
            <Input
              aria-label="Title"
              autoFocus
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              disabled={suggest.isPending}
              title="Ask a small model for a short title (you can still edit it)"
              onClick={() => suggest.mutate(node.id, { onSuccess: (s) => setTitle(s.title) })}
            >
              <SparklesIcon /> {suggest.isPending ? 'Thinking…' : 'Suggest'}
            </Button>
          </div>
          {suggest.isError && <p className="text-sm text-destructive">{suggest.error.message}</p>}
          {rename.isError && <p className="text-sm text-destructive">{rename.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!trimmed || rename.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
