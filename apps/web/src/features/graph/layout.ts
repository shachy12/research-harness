import dagre from '@dagrejs/dagre'
import type { DagNode } from '@harness/shared'

// Cards have a fixed size, so the layout can be computed without measuring the DOM.
export const CARD_WIDTH = 240
export const CARD_HEIGHT = 128

/** Top-to-bottom layered layout: parents above children, merge nodes below all their parents. */
export function layoutGraph(nodes: DagNode[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 72 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) g.setNode(n.id, { width: CARD_WIDTH, height: CARD_HEIGHT })
  for (const n of nodes) for (const p of n.parentIds) g.setEdge(p, n.id)

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const { x, y } = g.node(n.id) // dagre gives the center point
    positions.set(n.id, { x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 })
  }
  return positions
}
