import type { DagNode, Message } from '@harness/shared';

/** Read access to one project's graph. The context logic only needs these two lookups. */
export interface GraphReader {
  node(id: string): DagNode;
  messages(nodeId: string): Message[];
}

/** An in-memory snapshot of a project, used by the routes and by tests. */
export class GraphSnapshot implements GraphReader {
  private readonly nodesById: Map<string, DagNode>;
  private readonly messagesByNode: Map<string, Message[]>;

  constructor(nodes: DagNode[], messages: Message[]) {
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    this.messagesByNode = new Map();
    for (const m of messages) {
      const list = this.messagesByNode.get(m.nodeId) ?? [];
      list.push(m);
      this.messagesByNode.set(m.nodeId, list);
    }
  }

  node(id: string): DagNode {
    const n = this.nodesById.get(id);
    if (!n) throw new Error(`Unknown node ${id}`);
    return n;
  }

  messages(nodeId: string): Message[] {
    return this.messagesByNode.get(nodeId) ?? [];
  }

  allNodes(): DagNode[] {
    return [...this.nodesById.values()];
  }

  children(id: string): DagNode[] {
    return this.allNodes().filter((n) => n.parentIds.includes(id));
  }
}

/** Length of the longest path from a root to this node. */
export function depth(graph: GraphReader, id: string): number {
  const { parentIds } = graph.node(id);
  return parentIds.length ? Math.max(...parentIds.map((p) => depth(graph, p))) + 1 : 0;
}

export function ancestors(graph: GraphReader, id: string, acc = new Set<string>()): Set<string> {
  for (const p of graph.node(id).parentIds) {
    if (!acc.has(p)) {
      acc.add(p);
      ancestors(graph, p, acc);
    }
  }
  return acc;
}

/**
 * Lowest common ancestor of several nodes: the deepest node that is a strict ancestor of all of them.
 * This is the base context a merge node starts from. Null if they share no ancestor.
 */
export function lowestCommonAncestor(graph: GraphReader, ids: string[]): string | null {
  if (ids.length === 0) return null;
  const sets = ids.map((id) => ancestors(graph, id));
  const common = [...sets[0]].filter((a) => sets.every((s) => s.has(a)));
  if (common.length === 0) return null;
  return common.reduce((best, a) => (depth(graph, a) > depth(graph, best) ? a : best));
}
