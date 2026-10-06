import dagre from '@dagrejs/dagre'
import type { DagNode } from '@harness/shared'

// Cards have a fixed size, so the layout can be computed without measuring the DOM.
export const CARD_WIDTH = 240
export const CARD_HEIGHT = 128

// A hidden node above every root, so all roots sit on the top row.
const TOP = '__top__'

/**
 * Top-to-bottom layered layout: parents above children, merge nodes below all their parents, and
 * every root on the top row. Without the hidden top node, dagre would move a root down next to a
 * deep node it was merged into (e.g. a node whose parent was deleted): the strongly weighted edges
 * from the top node keep each root one row below it.
 */
export function layoutGraph(nodes: DagNode[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 72 })
  g.setDefaultEdgeLabel(() => ({}))

  g.setNode(TOP, { width: 0, height: 0 })
  for (const n of nodes) g.setNode(n.id, { width: CARD_WIDTH, height: CARD_HEIGHT })
  for (const n of nodes) {
    if (n.parentIds.length === 0) g.setEdge(TOP, n.id, { weight: 1000, minlen: 1 })
    for (const p of n.parentIds) g.setEdge(p, n.id)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const { x, y } = g.node(n.id) // dagre gives the center point
    positions.set(n.id, { x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 })
  }
  return positions
}
