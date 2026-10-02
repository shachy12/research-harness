import type { Project } from '@harness/shared'
import { useState } from 'react'
import { useRenameProject } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export function RenameProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name)
  const rename = useRenameProject()
  const trimmed = name.trim()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          {project.folder && <DialogDescription className="font-mono text-xs break-all">{project.folder}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!trimmed || trimmed === project.name) return onClose()
            rename.mutate({ projectId: project.id, name: trimmed }, { onSuccess: onClose })
          }}
        >
          <Input aria-label="Name" autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
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
