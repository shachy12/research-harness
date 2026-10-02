import { type Segment, fullSegments, inheritedSegments } from './context.ts';
import type { GraphReader } from './graph.ts';
import { type ChatTurn, branchStartNote, resultsTurn, segmentTurns } from './prompt.ts';

/**
 * How a session-based provider (Claude Code) should start this node's conversation.
 * Computed before the new user message is saved.
 *
 *   resume:  the node already has a session; just continue it
 *   fork:    copy the parent's (or, for a merge, the base's) session and continue in the copy
 *   new:     start an empty session
 *
 * `preamble` goes before the first message: the branch-start note, or the merged results.
 * `transcript` seeds a new session with earlier context when there is no session to fork from
 * (e.g. the nodes were created with another provider).
 */
export interface SessionPlan {
  mode: 'resume' | 'fork' | 'new';
  sessionId: string | null;
  preamble: string | null;
  transcript: ChatTurn[];
}

const turnsOf = (segments: Segment[]) => segments.flatMap(segmentTurns);

/**
 * `retry`: the node's last message is a saved user message that got no reply and is being sent
 * again, so plan as if it weren't saved yet.
 */
export function planSession(graph: GraphReader, nodeId: string, { retry = false } = {}): SessionPlan {
  const node = graph.node(nodeId);
  if (node.sessionId) return { mode: 'resume', sessionId: node.sessionId, preamble: null, transcript: [] };

  // Messages exist but no session (written by another provider): replay everything as a transcript.
  const earlier = graph.messages(nodeId).length - (retry ? 1 : 0);
  if (earlier > 0) {
    const transcript = turnsOf(fullSegments(graph, nodeId));
    return { mode: 'new', sessionId: null, preamble: null, transcript: retry ? transcript.slice(0, -1) : transcript };
  }

  if (node.parentIds.length === 0) return { mode: 'new', sessionId: null, preamble: null, transcript: [] };

  // The session to copy: the parent's, or for a merge node, the base's (where the merged branches forked).
  const inherited = inheritedSegments(graph, nodeId);
  const results = inherited.find((s) => s.kind === 'results');
  const preamble = results ? resultsTurn(results) : branchStartNote(node.promptTitle);
  const sourceSegments = results ? inherited.slice(0, -1) : inherited;
  const sourceId = results ? baseOf(inherited) : node.parentIds[0];
  const source = sourceId ? graph.node(sourceId) : null;

  if (source?.sessionId) return { mode: 'fork', sessionId: source.sessionId, preamble, transcript: [] };
  return { mode: 'new', sessionId: null, preamble, transcript: turnsOf(sourceSegments) };
}

/** The node whose full context precedes the merged results (the last messages segment before them). */
function baseOf(inherited: Segment[]): string | null {
  for (let i = inherited.length - 2; i >= 0; i--) {
    const seg = inherited[i];
    if (seg.kind === 'messages') return seg.node.id;
  }
  return null;
}

/** The text to send as a node's first message: earlier context (if any), the preamble, then the message. */
export function firstMessage(plan: SessionPlan, message: string): string {
  const parts: string[] = [];
  if (plan.transcript.length > 0) parts.push(renderTranscript(plan.transcript));
  if (plan.preamble) parts.push(plan.preamble);
  parts.push(message);
  return parts.join('\n\n');
}

export function renderTranscript(turns: ChatTurn[]): string {
  const body = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  return `[Earlier conversation, carried over as context:]\n\n${body}\n\n[End of earlier conversation]`;
}
