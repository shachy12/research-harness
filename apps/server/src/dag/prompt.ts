import { type Segment, formatResult, fullSegments, inheritedSegments } from './context.ts';
import type { GraphReader } from './graph.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Mark the end of a prefix worth caching (the end of the inherited context). */
  cacheBreakpoint?: boolean;
}

export interface ChatRequest {
  system: string;
  turns: ChatTurn[];
}

// Kept identical for every node, so sibling branches share a cacheable prompt prefix.
// Node-specific framing goes into the conversation at the point where the branch starts.
export const SYSTEM_PROMPT = `You are a research assistant in a workspace where research is organized as a graph of conversations.
A conversation can be forked into branches, each exploring one sub-question with the full context of the conversation before it.
When a branch is finished, its result (findings, evidence, open questions, confidence) is merged back into a later node; the branch transcript is not.
Notes in square brackets mark where a branch starts or where branch results are merged in.`;

export function branchStartNote(title: string): string {
  return `[A new branch starts here: "${title}". It explores this sub-question using the conversation above as context. Stay focused on it; the findings will be summarized and merged back later.]`;
}

export function resultsTurn(seg: Extract<Segment, { kind: 'results' }>): string {
  const blocks = seg.branches
    .filter((b) => b.result)
    .map((b) => formatResult(b.title, b.result!));
  return [
    `[Merge node "${seg.mergeNode.title}". The following branches were explored separately and are merged here. Only their final results are included, not their transcripts.]`,
    ...blocks,
  ].join('\n\n');
}

function segmentTurns(seg: Segment): ChatTurn[] {
  switch (seg.kind) {
    case 'messages':
      return seg.messages.map((m) => ({ role: m.role, content: m.content }));
    case 'branch-start':
      return [{ role: 'user', content: branchStartNote(seg.node.title) }];
    case 'results':
      return [{ role: 'user', content: resultsTurn(seg) }];
  }
}

/**
 * Build the model request for a node: its full context as turns.
 * The last inherited turn carries a cache breakpoint, so sibling branches reuse the cached prefix.
 */
export function buildChatRequest(graph: GraphReader, nodeId: string, extraTurns: ChatTurn[] = []): ChatRequest {
  const inheritedCount = inheritedSegments(graph, nodeId).flatMap(segmentTurns).length;
  const turns = fullSegments(graph, nodeId).flatMap(segmentTurns);
  if (inheritedCount > 0) turns[inheritedCount - 1] = { ...turns[inheritedCount - 1], cacheBreakpoint: true };
  return { system: SYSTEM_PROMPT, turns: [...turns, ...extraTurns] };
}

export const DRAFT_RESULT_INSTRUCTION = `[This branch is finished. Write its result report, to be merged back into the main research.
Use only what this branch established.
- findings: the key conclusions, self-contained and specific
- evidence: the sources, data or reasoning that support them (keep source names and links)
- openQuestions: what is still unresolved or worth a follow-up (empty if none)
- confidence: low, medium or high]`;
