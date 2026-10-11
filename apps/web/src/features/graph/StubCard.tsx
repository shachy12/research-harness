import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { UnfoldVerticalIcon } from 'lucide-react'
import type { BranchStub } from './folds'
import { STUB_HEIGHT, STUB_WIDTH } from './layout'

export type StubData = { stub: BranchStub }
export type StubNode = Node<StubData, 'stub'>

// Edges attach to invisible handles at the top and bottom of the card.
const hiddenHandle = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

/**
 * Stands for a node's folded done branches, under that node. Clicking it shows them again (the
 * graph page handles the click, like a card's).
 */
export function StubCard({ data }: NodeProps<StubNode>) {
  const { branches, nodes } = data.stub
  const count = branches.length
  return (
    <div className="relative" title={`Show the folded branches: ${branches.join(', ')}`}>
      {/* Two cards peeking out behind: the branches it hides. */}
      <div aria-hidden="true" className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-done/50 bg-done-soft" />
      <div aria-hidden="true" className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl border border-done/60 bg-done-soft" />
      <div
        style={{ width: STUB_WIDTH, height: STUB_HEIGHT }}
        className="relative flex cursor-pointer flex-col justify-center gap-0.5 rounded-xl border border-dashed border-done/80 bg-done-soft px-3 text-done transition-colors hover:border-done"
      >
        <Handle type="target" position={Position.Top} isConnectable={false} className={hiddenHandle} />
        <span className="flex items-center gap-1 text-xs font-semibold">
          <UnfoldVerticalIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {count} done {count === 1 ? 'branch' : 'branches'} folded
        </span>
        <span className="text-[11px] text-muted-foreground">
          {nodes} {nodes === 1 ? 'node' : 'nodes'} · <span className="font-semibold text-done">Show</span>
        </span>
        <Handle type="source" position={Position.Bottom} isConnectable={false} className={hiddenHandle} />
      </div>
    </div>
  )
}
