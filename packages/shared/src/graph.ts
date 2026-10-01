import type { DagNode } from './types.ts';

/** Look up a node by id (throws or returns the node). Lets these helpers work on any graph source. */
export type NodeLookup = (id: string) => DagNode;

/** Length of the longest path from a root to this node. */
export function depth(get: NodeLookup, id: string): number {
  const { parentIds } = get(id);
  return parentIds.length ? Math.max(...parentIds.map((p) => depth(get, p))) + 1 : 0;
}

export function ancestors(get: NodeLookup, id: string, acc = new Set<string>()): Set<string> {
  for (const p of get(id).parentIds) {
    if (!acc.has(p)) {
      acc.add(p);
      ancestors(get, p, acc);
    }
  }
  return acc;
}

/**
 * Lowest common ancestor of several nodes: the deepest node that is a strict ancestor of all of them.
 * This is the base context a merge node starts from. Null if they share no ancestor.
 */
export function lowestCommonAncestor(get: NodeLookup, ids: string[]): string | null {
  if (ids.length === 0) return null;
  const sets = ids.map((id) => ancestors(get, id));
  const common = [...sets[0]].filter((a) => sets.every((s) => s.has(a)));
  if (common.length === 0) return null;
  return common.reduce((best, a) => (depth(get, a) > depth(get, best) ? a : best));
}
