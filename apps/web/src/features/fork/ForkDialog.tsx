import type { DagNode } from '@harness/shared'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFork } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Name the sub-questions, create one branch per name, then show them on the graph. */
export function ForkDialog({ node, inheritedTokens, onClose }: {
  node: DagNode
  inheritedTokens: number
  onClose: () => void
}) {
  const [titles, setTitles] = useState(['', ''])
  const fork = useFork()
  const navigate = useNavigate()

  const named = titles.map((t) => t.trim()).filter(Boolean)
  const create = () =>
    fork.mutate(
      { nodeId: node.id, titles: named.length ? named : ['Branch 1', 'Branch 2'] },
      { onSuccess: () => navigate(`/projects/${node.projectId}`) },
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fork "{node.title}"</DialogTitle>
          <DialogDescription>
            Each branch starts with this node's full context (~{inheritedTokens.toLocaleString()} tokens).
            {node.status === 'open' && ' After forking, this node is frozen.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          {titles.map((value, i) => (
            <div key={i} className="grid gap-1.5">
              <Label htmlFor={`fork-branch-${i}`}>Branch {i + 1}</Label>
              <Input
                id={`fork-branch-${i}`}
                autoFocus={i === 0}
                placeholder="Sub-question, e.g. Compare storage costs"
                value={value}
                onChange={(e) => setTitles(titles.map((t, j) => (j === i ? e.target.value : t)))}
              />
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setTitles([...titles, ''])} disabled={titles.length >= 12}>
              + Add branch
            </Button>
          </div>
          {fork.isError && <p className="text-sm text-destructive">{fork.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={fork.isPending}>
              {fork.isPending ? 'Creating…' : `Create ${Math.max(named.length, 2)} branches`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
