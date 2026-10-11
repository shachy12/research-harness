import dagre from '@dagrejs/dagre'
import type { DagNode } from '@harness/shared'

// Cards have a fixed size, so the layout can be computed without measuring the DOM.
export const CARD_WIDTH = 240
export const CARD_HEIGHT = 128
// The stub card that stands for a node's folded done branches.
export const STUB_WIDTH = 200
export const STUB_HEIGHT = 56

type LayoutNode = Pick<DagNode, 'id' | 'parentIds'> & { width?: number; height?: number }

// A hidden node above every root, so all roots sit on the top row.
const TOP = '__top__'

/**
 * Top-to-bottom layered layout: parents above children, merge nodes below all their parents, and
 * every root on the top row. Without the hidden top node, dagre would move a root down next to a
 * deep node it was merged into (e.g. a node whose parent was deleted): the strongly weighted edges
 * from the top node keep each root one row below it. Nodes are card-sized unless they say otherwise.
 */
export function layoutGraph(nodes: LayoutNode[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 72 })
  g.setDefaultEdgeLabel(() => ({}))

  g.setNode(TOP, { width: 0, height: 0 })
  for (const n of nodes) g.setNode(n.id, { width: n.width ?? CARD_WIDTH, height: n.height ?? CARD_HEIGHT })
  for (const n of nodes) {
    if (n.parentIds.length === 0) g.setEdge(TOP, n.id, { weight: 1000, minlen: 1 })
    for (const p of n.parentIds) g.setEdge(p, n.id)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const { x, y, width, height } = g.node(n.id) // dagre gives the center point
    positions.set(n.id, { x: x - width / 2, y: y - height / 2 })
  }
  return positions
}
