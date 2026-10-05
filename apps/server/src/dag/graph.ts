import { type DagNode, type Message, lowestCommonAncestor as lcaOf } from '@harness/shared';

/** Read access to one project's graph. The context logic only needs these lookups. */
export interface GraphReader {
  node(id: string): DagNode;
  messages(nodeId: string): Message[];
  children(id: string): DagNode[];
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

export function lowestCommonAncestor(graph: GraphReader, ids: string[]): string | null {
  return lcaOf((id) => graph.node(id), ids);
}
