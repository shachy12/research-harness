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
You should never take a user prompt as a research you conduct yourself; the work is interactive, you should work together with the researcher. 
You should never make up facts or sources; if you do not know something, say so. 
You should give suggestions for next steps, but never make decisions for the user. You should always be concise and specific, and avoid repeating yourself.
Only start a sub-research when the user explicitly asks you to, and only when you have enough context to do so, feel free to suggest doing a specific research.
A conversation can be forked into branches, each exploring one sub-question with the full context of the conversation before it.
When a branch is finished, its result (findings, evidence, open questions, confidence) is merged back into a later node; the branch transcript is not.
Notes in square brackets mark where a branch starts or where branch results are merged in.
You can search the web and fetch pages. Use them for anything that depends on current or specific facts, and cite your sources with links.

Formatting: write Markdown; use tables for comparisons. Write math as $…$ inline and $$…$$ for displayed equations (not \\(…\\) or \\[…\\]), and escape dollar signs that are not math (\\$5). When giving LaTeX source for the user to copy (document fragments, macros, tables), put it in a \`\`\`latex code block so it is shown as code, not rendered.`;

export function branchStartNote(title: string): string {
  return `[A new branch starts here: "${title}". It explores this sub-question using the conversation above as context. Stay focused on it; the findings will be summarized and merged back later.]`;
}

export function resultsTurn(seg: Extract<Segment, { kind: 'results' }>): string {
  const blocks = seg.results.map(({ node, result }) => formatResult(node.promptTitle, result));
  return [
    `[Merge node "${seg.mergeNode.promptTitle}". The following branches were explored separately and are merged here. Only their final results are included, not their transcripts.]`,
    ...blocks,
    ...(seg.skipped.length ? [skippedNote(seg.skipped)] : []),
  ].join('\n\n');
}

/** Which conversations the merge left out, by node id, so the model can ask them (ask_node tool). */
function skippedNote(nodes: { id: string; promptTitle: string }[]): string {
  const list = nodes.map((n) => `- "${n.promptTitle}" (node ${n.id})`).join('\n');
  return `[These conversations led to the results above but are not in your context:\n${list}\nIf you need details a result leaves out (evidence, reasoning, exact numbers, sources), ask the node with the ask_node tool.]`;
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

/**
 * Sent in front of the first message a node runs with an editable copy (projects with file editing
 * on). The project folder stays the working folder (sessions belong to it), so the model has to be
 * told where it may write. A merge node also hears what the merged branches changed, and which
 * files were left with conflict markers.
 */
export function editNote(edit: {
  dir: string;
  branch: string;
  merged: { title: string; files: string[] }[];
  conflicts: string[];
  /** The copy started from the project's checked-out branch (this name), not the conversation's files. */
  fromProject?: string | null;
}): string {
  const holds = edit.fromProject
    ? `it holds the project files as they are on the project's branch ${edit.fromProject}, not as the conversation above left them: file changes made earlier in this conversation are not in it. `
    : 'it holds the project files as the conversation above left them. ';
  const lines = [
    `[You can edit files in this conversation. Your own copy of the project is at ${edit.dir} (git branch ${edit.branch}); ` +
      holds + 'Make every change there, with Edit or Write and absolute paths. ' +
      'The project folder itself and other copies are read-only for you; copies mentioned earlier in the conversation belong to other branches. ' +
      `You can also run shell commands with the Bash tool (e.g. to compile or run scripts): run them inside your copy (cd ${shellPath(edit.dir)} first) and never change files outside it. ` +
      'Files that commands create there (build outputs too) count as your changes, so delete the ones the user should not get. ' +
      'Your changes are saved after each reply; the user reviews them and applies them to the project.',
  ];
  const changed = edit.merged.filter((m) => m.files.length > 0);
  if (changed.length > 0) {
    lines.push(`The merged branches' file changes are combined in your copy: ${changed.map((m) => `"${m.title}" changed ${m.files.join(', ')}`).join('; ')}.`);
  }
  if (edit.conflicts.length > 0) {
    lines.push(`Some changes overlap: ${edit.conflicts.join(', ')} ${edit.conflicts.length === 1 ? 'has' : 'have'} git conflict markers (<<<<<<<, =======, >>>>>>>). Resolve them in your copy first, keeping what each branch meant.`);
  }
  return `${lines.join('\n')}]`;
}

/** A path as the shell needs it, quoted; forward slashes work in Git Bash on Windows too. */
function shellPath(p: string): string {
  return `"${p.replaceAll('\\', '/')}"`;
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

export const DRAFT_RESULT_INSTRUCTION = `[This conversation is being merged with others into a new node. Write its result report: only this report goes into the merge, not the conversation.
Use only what this conversation established.
- findings: the key conclusions, self-contained and specific
- evidence: the sources, data or reasoning that support them (keep source names and links)
- openQuestions: what is still unresolved or worth a follow-up (empty if none)
- confidence: low, medium or high]`;
