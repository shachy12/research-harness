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
} from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useGraph, useNewRoot, useRefreshAll } from '@/api/queries'
import { api } from '@/api/client'
import { UsageBanner } from '@/components/UsageBanner'
import { Button } from '@/components/ui/button'
import { PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { MergeDialog } from '@/features/merge/MergeDialog'
import { useMergeSelection } from '@/features/merge/selection'
import { RenameDialog } from '@/features/rename/RenameDialog'
import { layoutGraph } from './layout'
import { type CardNode, NodeCard } from './NodeCard'
import { DeleteNodeDialog } from './DeleteNodeDialog'
import { DeletedNodesDialog } from './DeletedNodesDialog'
import { ResetDialog } from './ResetDialog'
import { forgetView, rememberView, rememberedView } from './viewMemory'

const nodeTypes = { card: NodeCard }

export function GraphPage() {
  const projectId = useParams().projectId!
  // One React Flow per project (`key`): switching projects keeps this page mounted, and React Flow
  // applies the remembered view (`defaultViewport`) only when it mounts.
  return (
    <ReactFlowProvider key={projectId}>
      <GraphView projectId={projectId} />
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
  const [resetOpen, setResetOpen] = useState(false)
  const [renaming, setRenaming] = useState<NodeSummary | null>(null)
  const [deleting, setDeleting] = useState<NodeSummary | null>(null)
  const [deletedOpen, setDeletedOpen] = useState(false)
  const deleted = graph.data?.deleted ?? []
  const [retrying, setRetrying] = useState(false)
  const flow = useReactFlow()
  const refresh = useRefreshAll()
  const newRoot = useNewRoot(projectId)

  const summaries = useMemo(() => graph.data?.nodes ?? [], [graph.data])
  // Any node can be merged, except a merge node that hasn't started yet (it has nothing to give).
  const mergeableIds = useMemo(() => new Set(summaries.filter((n) => !n.merge).map((n) => n.id)), [summaries])

  useEffect(() => {
    if (graph.data) selection.keepOnly(mergeableIds)
  }, [graph.data, mergeableIds, selection])

  const usage = graph.data?.usage ?? null
  const limitReached = usage?.status === 'reached'
  const { nodes, edges } = useMemo(
    () => toFlow(summaries, selection.ids, shake, limitReached, setRenaming, setDeleting),
    [summaries, selection.ids, shake, limitReached],
  )
  // Nodes whose last message got no reply (failed, stopped, or hit the limit), and merges that
  // stopped before their results were written (Retry starts them again).
  const unanswered = summaries.filter((n) =>
    (!n.running && !n.merge && n.lastRole === 'user') || (n.merge !== null && !n.merge.running))
  const retryAll = async () => {
    setRetrying(true)
    await Promise.allSettled(unanswered.map((n) => api.post(`/nodes/${n.id}/retry`)))
    await refresh()
    setRetrying(false)
  }

  // Fit the view the first time, and whenever the number of nodes changed since the last visit.
  // Each project's pan/zoom is remembered (viewMemory), so returning to it keeps the view; new or
  // removed nodes (a fork, a merge, a delete) trigger a re-fit.
  const memory = rememberedView(projectId)
  useEffect(() => {
    if (!graph.data) return
    const remembered = rememberedView(projectId)
    if (!remembered || remembered.nodeCount !== nodes.length) {
      const nodeCount = nodes.length
      requestAnimationFrame(async () => {
        await flow.fitView({ padding: 0.2, maxZoom: 1, duration: remembered ? 300 : 0 })
        rememberView(projectId, { viewport: flow.getViewport(), nodeCount })
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
          if (mergeableIds.has(node.id)) {
            setHint(null)
            selection.toggle(node.id)
          } else {
            setHint('This merge has not started yet, so it has nothing to merge.')
            setShake((s) => ({ id: node.id, key: (s?.key ?? 0) + 1 }))
          }
        }}
        onPaneContextMenu={(event) => event.preventDefault()}
        onMoveEnd={(_, viewport) => rememberView(projectId, { viewport, nodeCount: nodes.length })}
      >
        <Background gap={20} size={1.2} color="var(--edge)" />
        <Controls showInteractive={false} position="top-right" />
        {(usage || unanswered.length > 1) && (
          <Panel position="top-center" className="max-w-[min(640px,calc(100vw-2rem))]">
            {usage ? (
              <UsageBanner usage={usage} className="bg-card shadow-sm">
                {unanswered.length > 0 && limitReached && <RetryAll count={unanswered.length} busy={retrying} onClick={retryAll} />}
              </UsageBanner>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
                <span>{unanswered.length} nodes have no reply.</span>
                <RetryAll count={unanswered.length} busy={retrying} onClick={retryAll} />
              </div>
            )}
          </Panel>
        )}
        <Panel position="top-left" className="flex flex-col items-start gap-2">
          <div className="pointer-events-none flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--edge)" strokeWidth="2" /></svg>
            inherits full context
          </span>
          <span className="flex items-center gap-2">
            <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--status-merge)" strokeWidth="2" strokeDasharray="5 4" /></svg>
            passes only its result
          </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={newRoot.isPending}
            title="Start another independent conversation in this project (same folder, no shared context)"
            onClick={() => newRoot.mutate()}
          >
            <PlusIcon /> New root
          </Button>
          {newRoot.isError && <span className="rounded-lg bg-card px-2 py-1 text-xs text-destructive">{newRoot.error.message}</span>}
          <Button variant="outline" size="sm" className="bg-card" onClick={() => setResetOpen(true)}>
            <RotateCcwIcon /> Start over
          </Button>
          {deleted.length > 0 && (
            <Button variant="outline" size="sm" className="bg-card" onClick={() => setDeletedOpen(true)}>
              <Trash2Icon /> Deleted ({deleted.length})
            </Button>
          )}
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
                ? 'Select at least one more node to merge.'
                : 'Click a node to open its chat. Right-click nodes to select them for merge.')}
          </span>
        </Panel>
      </ReactFlow>

      {resetOpen && (
        <ResetDialog
          projectId={projectId}
          nodeCount={summaries.length}
          onDone={() => {
            selection.clear()
            setHint(null)
            forgetView(projectId) // re-fit the view to the new, single root
          }}
          onClose={() => setResetOpen(false)}
        />
      )}

      {renaming && <RenameDialog node={renaming} onClose={() => setRenaming(null)} />}
      {deletedOpen && <DeletedNodesDialog deleted={deleted} onClose={() => setDeletedOpen(false)} />}
      {deleting && (
        <DeleteNodeDialog
          node={deleting}
          childCount={summaries.filter((n) => n.parentIds.includes(deleting.id)).length}
          running={deleting.running}
          onDeleted={() => setHint(null)}
          onClose={() => setDeleting(null)}
        />
      )}

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

function RetryAll({ count, busy, onClick }: { count: number; busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" className="bg-card text-foreground" disabled={busy} onClick={onClick}>
      {busy ? 'Retrying…' : count === 1 ? 'Retry it' : `Retry all ${count}`}
    </Button>
  )
}

function toFlow(
  summaries: NodeSummary[],
  selected: string[],
  shake: { id: string; key: number } | null,
  limitReached: boolean,
  onRename: (node: NodeSummary) => void,
  onDelete: (node: NodeSummary) => void,
) {
  const positions = layoutGraph(summaries)
  const nodes: CardNode[] = summaries.map((summary) => ({
    id: summary.id,
    type: 'card',
    position: positions.get(summary.id)!,
    data: {
      summary,
      mergeSelected: selected.includes(summary.id),
      shakeKey: shake?.id === summary.id ? shake.key : 0,
      limitReached,
      onRename,
      onDelete,
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
