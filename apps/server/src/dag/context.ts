import { type BranchResult, type ContextItem, type DagNode, type Message, ancestors, depth } from '@harness/shared';
import { type GraphReader, lowestCommonAncestor } from './graph.ts';

/**
 * A node's full context is a flat list of segments, in prompt order:
 *
 *   root:        [own messages]
 *   branch:      [parent's full context up to the fork point] + [branch-start] + [own messages]
 *   merge node:  [base's full context up to the fork point] + [results of each merged branch] + [own messages]
 *
 * where "base" is the lowest common ancestor of the merged branches. A node can go on after it was
 * forked; its branches inherit only what it had then (`DagNode.forkPoint`), and a merge cuts the
 * base where the earliest of the merged branches' lines forked off it (`mergeBase`). Merged branches
 * contribute only their result, never their transcript. `skipped` lists the nodes whose
 * conversations the merge leaves out (the merged branches and the nodes between them and the
 * base), so the model can ask them for details (ask_node).
 */
export type Segment =
  | { kind: 'messages'; node: DagNode; messages: Message[] }
  | { kind: 'branch-start'; node: DagNode }
  | { kind: 'results'; mergeNode: DagNode; branches: DagNode[]; skipped: DagNode[] };

/** What the node inherits, before its own messages. */
export function inheritedSegments(graph: GraphReader, nodeId: string): Segment[] {
  const node = graph.node(nodeId);
  if (node.parentIds.length === 0) return [];
  if (node.parentIds.length === 1) return fullSegments(graph, node.parentIds[0], node.forkPoint);

  const base = mergeBase(graph, node.parentIds);
  return [
    ...(base ? fullSegments(graph, base.id, base.upto) : []),
    { kind: 'results', mergeNode: node, branches: node.parentIds.map((p) => graph.node(p)), skipped: skippedByMerge(graph, node.parentIds, base?.id ?? null) },
  ];
}

/**
 * Where a merge of these branches starts: their lowest common ancestor, cut at the earliest fork
 * point among its branches that lead to them (`upto`: how many of its messages; null: all), and
 * the session holding exactly that context (the base's own session when nothing is cut off).
 */
export function mergeBase(graph: GraphReader, branchIds: string[]): { id: string; upto: number | null; session: string | null } | null {
  const id = lowestCommonAncestor(graph, branchIds);
  if (!id) return null;
  const get = (n: string) => graph.node(n);
  // The base's children on the way to the merged branches.
  const onPath = new Set<string>();
  for (const b of branchIds) for (const a of [b, ...ancestors(get, b)]) if (get(a).parentIds.includes(id)) onPath.add(a);
  let first: DagNode | null = null;
  for (const c of [...onPath].map(get)) {
    if (c.parentIds.length !== 1 || c.forkPoint === null) continue; // a merge child, or no fork point: inherits it all
    if (!first || c.forkPoint < first.forkPoint!) first = c;
  }
  const all = graph.messages(id).length;
  if (!first || first.forkPoint! >= all) return { id, upto: null, session: first ? first.forkSession : get(id).sessionId };
  return { id, upto: first.forkPoint, session: first.forkSession };
}

/**
 * The nodes whose conversations a merge leaves out: the merged branches and their ancestors, minus
 * the base and its ancestors (those are in the context in full). Oldest first.
 */
export function skippedByMerge(graph: GraphReader, branchIds: string[], base: string | null): DagNode[] {
  const get = (id: string) => graph.node(id);
  const inContext = base ? ancestors(get, base).add(base) : new Set<string>();
  const skipped = new Set<string>();
  for (const id of branchIds) for (const a of [id, ...ancestors(get, id)]) if (!inContext.has(a)) skipped.add(a);
  return [...skipped]
    .map(get)
    .sort((a, b) => depth(get, a.id) - depth(get, b.id) || a.createdAt.localeCompare(b.createdAt));
}

/** Everything the node knows: inherited context plus its own messages (the first `upto` of them, if given). */
export function fullSegments(graph: GraphReader, nodeId: string, upto: number | null = null): Segment[] {
  const node = graph.node(nodeId);
  const messages = graph.messages(nodeId);
  return [
    ...inheritedSegments(graph, nodeId),
    ...(node.parentIds.length === 1 ? [{ kind: 'branch-start', node } as const] : []),
    { kind: 'messages', node, messages: upto === null ? messages : messages.slice(0, upto) },
  ];
}

/** The inherited context as shown in the UI (messages and merged results). */
export function inheritedItems(graph: GraphReader, nodeId: string): ContextItem[] {
  const items: ContextItem[] = [];
  for (const seg of inheritedSegments(graph, nodeId)) {
    if (seg.kind === 'messages') {
      for (const message of seg.messages) {
        items.push({ kind: 'message', nodeId: seg.node.id, nodeTitle: seg.node.title, message });
      }
    } else if (seg.kind === 'results') {
      for (const b of seg.branches) {
        if (b.result) items.push({ kind: 'result', nodeId: b.id, nodeTitle: b.title, result: b.result });
      }
    }
  }
  return items;
}

export function formatResult(title: string, r: BranchResult): string {
  return [
    `## Branch: ${title}`,
    `Findings: ${r.findings}`,
    `Evidence and sources: ${r.evidence || '(none given)'}`,
    `Open questions: ${r.openQuestions || '(none)'}`,
    `Confidence: ${r.confidence}`,
  ].join('\n');
}
