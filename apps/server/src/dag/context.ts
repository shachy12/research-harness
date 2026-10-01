import type { BranchResult, ContextItem, DagNode, Message } from '@harness/shared';
import { type GraphReader, lowestCommonAncestor } from './graph.ts';

/**
 * A node's full context is a flat list of segments, in prompt order:
 *
 *   root:        [own messages]
 *   branch:      [parent's full context] + [branch-start] + [own messages]
 *   merge node:  [base's full context] + [results of each merged branch] + [own messages]
 *
 * where "base" is the lowest common ancestor of the merged branches. Merged branches
 * contribute only their result, never their transcript.
 */
export type Segment =
  | { kind: 'messages'; node: DagNode; messages: Message[] }
  | { kind: 'branch-start'; node: DagNode }
  | { kind: 'results'; mergeNode: DagNode; branches: DagNode[] };

/** What the node inherits, before its own messages. */
export function inheritedSegments(graph: GraphReader, nodeId: string): Segment[] {
  const node = graph.node(nodeId);
  if (node.parentIds.length === 0) return [];
  if (node.parentIds.length === 1) return fullSegments(graph, node.parentIds[0]);

  const base = lowestCommonAncestor(graph, node.parentIds);
  return [
    ...(base ? fullSegments(graph, base) : []),
    { kind: 'results', mergeNode: node, branches: node.parentIds.map((p) => graph.node(p)) },
  ];
}

/** Everything the node knows: inherited context plus its own messages. */
export function fullSegments(graph: GraphReader, nodeId: string): Segment[] {
  const node = graph.node(nodeId);
  return [
    ...inheritedSegments(graph, nodeId),
    ...(node.parentIds.length === 1 ? [{ kind: 'branch-start', node } as const] : []),
    { kind: 'messages', node, messages: graph.messages(nodeId) },
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
