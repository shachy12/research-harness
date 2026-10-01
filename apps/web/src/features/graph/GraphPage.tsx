import type { NodeSummary } from '@harness/shared'
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useGraph } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { MergeDialog } from '@/features/merge/MergeDialog'
import { useMergeSelection } from '@/features/merge/selection'
import { layoutGraph } from './layout'
import { type CardNode, NodeCard } from './NodeCard'

const nodeTypes = { card: NodeCard }

// Remember each project's pan/zoom and node count, so returning from a chat keeps the view,
// and new nodes (after a fork or merge) trigger a re-fit.
const viewMemory = new Map<string, { viewport: Viewport; nodeCount: number }>()

export function GraphPage() {
  return (
    <ReactFlowProvider>
      <GraphView projectId={useParams().projectId!} />
    </ReactFlowProvider>
  )
}

function GraphView({ projectId }: { projectId: string }) {
  const graph = useGraph(projectId)
  const navigate = useNavigate()
  const selection = useMergeSelection()
  const [shake, setShake] = useState<{ id: string; key: number } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const flow = useReactFlow()

  const summaries = useMemo(() => graph.data?.nodes ?? [], [graph.data])
  const finishedIds = useMemo(
    () => new Set(summaries.filter((n) => n.status === 'finished').map((n) => n.id)),
    [summaries],
  )

  useEffect(() => {
    if (graph.data) selection.keepOnly(finishedIds)
  }, [graph.data, finishedIds, selection])

  const { nodes, edges } = useMemo(() => toFlow(summaries, selection.ids, shake), [summaries, selection.ids, shake])

  // Fit the view the first time, and whenever the number of nodes changed since the last visit.
  const memory = viewMemory.get(projectId)
  useEffect(() => {
    if (!graph.data) return
    const remembered = viewMemory.get(projectId)
    if (!remembered || remembered.nodeCount !== nodes.length) {
      const nodeCount = nodes.length
      requestAnimationFrame(async () => {
        await flow.fitView({ padding: 0.2, maxZoom: 1, duration: remembered ? 300 : 0 })
        viewMemory.set(projectId, { viewport: flow.getViewport(), nodeCount })
      })
    }
  }, [graph.data, nodes.length, projectId, flow])

  const selectedCount = selection.ids.length

  if (graph.isError) {
    return <p className="p-6 text-sm text-destructive">Could not load the graph: {graph.error.message}</p>
  }

  return (
    <div className="h-full bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="system"
        defaultViewport={memory?.viewport}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => navigate(`/projects/${projectId}/nodes/${node.id}`)}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          if (finishedIds.has(node.id)) {
            setHint(null)
            selection.toggle(node.id)
          } else {
            setHint('Only finished nodes can be merged. Finish the branch first.')
            setShake((s) => ({ id: node.id, key: (s?.key ?? 0) + 1 }))
          }
        }}
        onPaneContextMenu={(event) => event.preventDefault()}
        onMoveEnd={(_, viewport) => viewMemory.set(projectId, { viewport, nodeCount: nodes.length })}
      >
        <Background gap={20} size={1.2} color="var(--edge)" />
        <Controls showInteractive={false} position="top-right" />
        <Panel position="top-left" className="pointer-events-none flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--edge)" strokeWidth="2" /></svg>
            inherits full context
          </span>
          <span className="flex items-center gap-2">
            <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--status-merge)" strokeWidth="2" strokeDasharray="5 4" /></svg>
            passes only its result
          </span>
        </Panel>
        <Panel position="bottom-left" className="flex flex-wrap items-center gap-2">
          <Button
            className="bg-merge text-white hover:bg-merge/90"
            disabled={selectedCount < 2}
            onClick={() => setMergeOpen(true)}
          >
            ⑃ Merge {selectedCount > 0 ? `${selectedCount} ` : ''}selected
          </Button>
          <span className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            {hint ??
              (selectedCount === 1
                ? 'Select at least one more finished branch to merge.'
                : 'Click a node to open its chat. Right-click finished nodes to select them for merge.')}
          </span>
        </Panel>
      </ReactFlow>

      {mergeOpen && (
        <MergeDialog
          projectId={projectId}
          nodes={summaries}
          parentIds={selection.ids}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  )
}

function toFlow(summaries: NodeSummary[], selected: string[], shake: { id: string; key: number } | null) {
  const positions = layoutGraph(summaries)
  const nodes: CardNode[] = summaries.map((summary) => ({
    id: summary.id,
    type: 'card',
    position: positions.get(summary.id)!,
    data: {
      summary,
      mergeSelected: selected.includes(summary.id),
      shakeKey: shake?.id === summary.id ? shake.key : 0,
    },
  }))

  const edges: Edge[] = summaries.flatMap((child) =>
    child.parentIds.map((parentId) => {
      const isMerge = child.parentIds.length > 1
      const color = isMerge ? 'var(--status-merge)' : 'var(--edge)'
      return {
        id: `${parentId}->${child.id}`,
        source: parentId,
        target: child.id,
        style: { stroke: color, strokeWidth: 1.8, strokeDasharray: isMerge ? '6 5' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        ...(isMerge && {
          label: 'result',
          labelStyle: { fill: 'var(--status-merge)', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
          labelBgStyle: { fill: 'var(--canvas)' },
        }),
      }
    }),
  )
  return { nodes, edges }
}
