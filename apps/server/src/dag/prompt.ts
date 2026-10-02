import type { Attachment, Message } from '@harness/shared';
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
Notes in square brackets mark where a branch starts or where branch results are merged in.
You can search the web and fetch pages. Use them for anything that depends on current or specific facts, and cite your sources with links.

Formatting: write Markdown; use tables for comparisons. Write math as $…$ inline and $$…$$ for displayed equations (not \\(…\\) or \\[…\\]), and escape dollar signs that are not math (\\$5). When giving LaTeX source for the user to copy (document fragments, macros, tables), put it in a \`\`\`latex code block so it is shown as code, not rendered.`;

export function branchStartNote(title: string): string {
  return `[A new branch starts here: "${title}". It explores this sub-question using the conversation above as context. Stay focused on it; the findings will be summarized and merged back later.]`;
}

export function resultsTurn(seg: Extract<Segment, { kind: 'results' }>): string {
  const blocks = seg.branches
    .filter((b) => b.result)
    .map((b) => formatResult(b.promptTitle, b.result!));
  return [
    `[Merge node "${seg.mergeNode.promptTitle}". The following branches were explored separately and are merged here. Only their final results are included, not their transcripts.]`,
    ...blocks,
  ].join('\n\n');
}

/**
 * Raw search results are not kept in the history (they are large). Instead each reply carries a
 * short list of the sources it consulted, so later turns and result drafts can cite them.
 */
export function withSources(m: Message): string {
  const sources = m.toolCalls.flatMap((c) => c.results).slice(0, 30);
  if (sources.length === 0) return m.content;
  const list = sources.map((s) => `- ${s.title} (${s.url})`).join('\n');
  return `${m.content}\n\n[Sources consulted for this reply:\n${list}]`;
}

/**
 * Attached files are not inlined: the message tells the model where they are, and it reads them
 * with its Read tool (Claude Code). Once read, the content is part of the session, so branches
 * forked later inherit it.
 */
export function withAttachments(content: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return content;
  const folders = attachments.filter((a) => a.kind === 'folder');
  const list = attachments
    .map((a) => (a.kind === 'folder' ? `- ${a.path} (folder, ${a.fileCount ?? 'several'} files)` : `- ${a.path}`))
    .join('\n');
  const how = folders.length
    ? 'Read files with the Read tool; for folders, list their contents with Glob and read the files relevant to the question'
    : `Read ${attachments.length === 1 ? 'it' : 'them'} with the Read tool`;
  const what = attachments.length === 1 ? (folders.length ? 'a folder' : 'a file') : `${attachments.length} attachments`;
  return `${content}\n\n[The user attached ${what}. ${how} before answering:\n${list}]`;
}

export function segmentTurns(seg: Segment): ChatTurn[] {
  switch (seg.kind) {
    case 'messages':
      return seg.messages.map((m) => ({
        role: m.role,
        content: m.role === 'user' ? withAttachments(m.content, m.attachments) : withSources(m),
      }));
    case 'branch-start':
      return [{ role: 'user', content: branchStartNote(seg.node.promptTitle) }];
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
