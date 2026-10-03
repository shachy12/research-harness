import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type DagNode, type ForkProposal, ancestors } from '@harness/shared';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import { buildChatRequest } from '../dag/prompt.ts';
import { planSession } from '../dag/session.ts';
import type { GraphSnapshot } from '../dag/graph.ts';
import type { Repository } from '../db/repository.ts';
import { classifyError } from '../llm/errors.ts';
import type { LLMProvider, ReplyContext } from '../llm/index.ts';
import { HttpError, notFound } from '../routes/errors.ts';
import type { RunManager } from '../runs.ts';
import type { Workspaces } from '../workspace.ts';

/**
 * The harness's own MCP server: tools that let the model work with the research graph.
 *
 *   fork_branches  propose branches of the current node; the user reviews and starts them
 *   ask_node       ask an earlier node (e.g. a branch merged here) a question about its conversation
 *
 * Each node has its own endpoint, `/api/mcp/<nodeId>`, so the tools know which node calls them
 * without the model naming it. The tool definitions are the same for every node: they are part of
 * the prompt, and identical prompts let sibling branches share the prompt cache.
 */

/** A tool call the model got wrong (unknown node, nothing running, …): sent back to it as an error. */
export class ToolError extends Error {}

const forkInput = {
  branches: z
    .array(z.object({
      prompt: z.string().trim().min(1).describe(
        "The branch's first message, sent as the user's message that starts it: a self-contained instruction saying what this branch should investigate or do. The branch sees this whole conversation, including the reply you are writing now.",
      ),
      title: z.string().trim().min(1).max(80).optional().describe('A short title for the graph (3-7 words).'),
    }))
    .min(1)
    .max(12),
};

const askInput = {
  nodeId: z.string().trim().min(1).describe('The id of the node to ask, as given in a merge note.'),
  question: z.string().trim().min(1).describe('A specific, self-contained question. The node does not see your conversation.'),
};

const FORK_DESCRIPTION = `Propose forking this conversation into parallel branches, one per sub-question or direction. Each branch inherits this whole conversation (including the reply you are writing now) and starts with its prompt as its first message.
The branches are not created right away: when your reply ends, the user reviews the proposal, can edit, add or remove branches, and starts them.
Use it when the user asks you to fork or branch out, or when the research clearly splits into independent directions that deserve separate investigation (then say so in your reply).
Calling it again in the same reply replaces the earlier proposal. After calling it, end your reply briefly; don't start the branches' work yourself.`;

const ASK_DESCRIPTION = `Ask an earlier conversation (node) of this research graph a question. Some conversations are not in your context in full: a branch merged into this conversation contributes only its result, and merge notes list such conversations with their node ids.
The node answers from its own full context (its conversation, the files it read, its sources), without changing it. Only nodes this conversation descends from can be asked.
Use it when you need details a result leaves out: evidence, reasoning, exact numbers, sources. Each question runs a model call, so ask specific questions and combine related ones.
A few questions per reply are free; after that each question waits for the user's approval. Each answer says how many free questions are left.`;

/** What the model hears when a question doesn't run. */
const REFUSED = {
  'no-reply': 'Other nodes can only be asked while writing a reply.',
  denied: "The user declined this question. Continue without its answer (asking again later needs the user's approval again).",
  away: "The user did not respond to the request to approve this question; they are probably away. Don't continue the research: end your reply briefly, say what you wanted to ask and why, and wait for the user's instructions.",
};

/** The message the asked node gets, in front of the question. */
export function askMessage(askerTitle: string, question: string): string {
  return `[Another conversation in this research graph, "${askerTitle}", asks this conversation a question. Answer from what this conversation established (findings, reasoning, evidence, sources), self-contained so it can be read without this conversation, and say plainly if this conversation did not cover it. Don't continue the research beyond what the question needs.]\n\n${question}`;
}

/**
 * The node `ref` names, if the asking node may ask it: one of its ancestors (its context, the
 * branches merged into it and what led to them). `ref` is a node id or an unambiguous start of one.
 */
export function askableNode(graph: GraphSnapshot, askerId: string, ref: string): DagNode {
  const allowed = [...ancestors((id) => graph.node(id), askerId)].map((id) => graph.node(id));
  const exact = allowed.find((n) => n.id === ref);
  if (exact) return exact;
  const matches = ref.length >= 6 ? allowed.filter((n) => n.id.startsWith(ref)) : [];
  if (matches.length === 1) return matches[0];
  throw new ToolError(
    `"${ref}" is not a node this conversation descends from, so it can't be asked. Use a node id from a merge note.`,
  );
}

export class HarnessTools {
  private readonly repo: Repository;
  private readonly llm: LLMProvider;
  private readonly runs: RunManager;
  private readonly workspaces: Workspaces;
  private readonly mcpUrl: (nodeId: string, chargeTo?: string) => string | null;

  constructor(deps: {
    repo: Repository;
    llm: LLMProvider;
    runs: RunManager;
    workspaces: Workspaces;
    mcpUrl: (nodeId: string, chargeTo?: string) => string | null;
  }) {
    this.repo = deps.repo;
    this.llm = deps.llm;
    this.runs = deps.runs;
    this.workspaces = deps.workspaces;
    this.mcpUrl = deps.mcpUrl;
  }

  /** fork_branches: attach the proposal to the node's running reply; it is saved with the reply. */
  proposeBranches(nodeId: string, branches: { prompt: string; title?: string }[]): string {
    const proposal: ForkProposal = { branches: branches.map((b) => ({ prompt: b.prompt, title: b.title ?? null })) };
    if (!this.runs.propose(nodeId, proposal)) {
      throw new ToolError('Branches can only be proposed while writing a reply in an open conversation.');
    }
    const n = proposal.branches.length;
    return `Proposed ${n} ${n === 1 ? 'branch' : 'branches'}. When your reply ends, the user reviews the proposal and starts the branches (possibly edited). Nothing has been created yet.`;
  }

  /**
   * ask_node: a one-off answer from the asked node's full context; its conversation is not changed.
   * The question counts against the reply running on `chargeTo`: the asking node's own reply, or
   * for a node that was itself asked (and asks further), the reply that started the chain.
   */
  async ask(askerId: string, chargeTo: string, ref: string, question: string, signal: AbortSignal): Promise<string> {
    const asker = this.repo.getNode(askerId);
    if (!asker) throw new ToolError('Unknown node.');
    if (!this.llm.askNode) throw new ToolError('This model provider cannot ask other nodes.');
    const graph = this.repo.snapshot(asker.projectId);
    const target = askableNode(graph, askerId, ref);
    if (graph.messages(target.id).length === 0) throw new ToolError(`"${target.title}" has no conversation yet.`);

    const from = askerId === chargeTo ? null : asker.title;
    const outcome = await this.runs.allowAsk(chargeTo, { nodeTitle: target.title, from, question }, signal);
    if (outcome.decision !== 'allowed') throw new ToolError(REFUSED[outcome.decision]);
    const left = `(${outcome.freeLeft} of ${this.runs.askLimit} free questions left in this reply; after that, questions need the user's approval.)`;

    const message = askMessage(asker.promptTitle, question);
    const ctx: ReplyContext = {
      nodeId: target.id,
      workDir: this.workspaces.prepare(this.repo.getProject(asker.projectId)!),
      request: buildChatRequest(graph, target.id, [{ role: 'user', content: message }]),
      message,
      session: planSession(graph, target.id),
      model: target.model,
      effort: target.effort,
      edit: null,
      // Its own questions (if it asks further) count against the same reply.
      mcpUrl: this.mcpUrl(target.id, chargeTo),
    };
    try {
      const answer = (await this.llm.askNode(ctx, signal)).answer.trim();
      return `${answer || `"${target.title}" gave no answer.`}\n\n${left}`;
    } catch (err) {
      if (signal.aborted) throw new ToolError('The question was cancelled.');
      console.error(`[ask_node] ${askerId} → ${target.id}:`, err);
      const error = classifyError(err);
      this.runs.noteFailure(error);
      throw new ToolError(`"${target.title}" could not answer: ${error.message}`);
    }
  }
}

/** What the MCP endpoint needs (check-cache serves it with stand-ins). */
export type ToolHandlers = Pick<HarnessTools, 'proposeBranches' | 'ask'>;

/** An MCP server for one node's requests (stateless: a new one per HTTP request). */
function serverFor(tools: ToolHandlers, nodeId: string, chargeTo: string, requestSignal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'harness', version: '1.0.0' });
  const run = async (fn: () => string | Promise<string>) => {
    try {
      return { content: [{ type: 'text' as const, text: await fn() }] };
    } catch (err) {
      if (!(err instanceof ToolError)) console.error(`[mcp] node ${nodeId}:`, err);
      return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
  server.registerTool('fork_branches', { description: FORK_DESCRIPTION, inputSchema: forkInput }, ({ branches }) =>
    run(() => tools.proposeBranches(nodeId, branches)),
  );
  server.registerTool('ask_node', { description: ASK_DESCRIPTION, inputSchema: askInput }, ({ nodeId: ref, question }, extra) =>
    run(() => tools.ask(nodeId, chargeTo, ref, question, AbortSignal.any([requestSignal, extra.signal]))),
  );
  return server;
}

/**
 * `/api/mcp/:nodeId`: the MCP endpoint (Streamable HTTP) the node's Claude Code process connects to.
 * `?for=<node>`: the node was asked a question by that node's reply, and its own questions count there.
 */
export function harnessMcpRoutes(tools: ToolHandlers, hasNode: (id: string) => boolean) {
  return new Hono().all('/:nodeId', async (c) => {
    // Only the CLI calls this. A web page always sends an Origin, so no page can call the tools.
    if (c.req.header('origin')) throw new HttpError(403, 'Not available to web pages');
    const nodeId = c.req.param('nodeId');
    const chargeTo = c.req.query('for') ?? nodeId;
    if (!hasNode(nodeId) || !hasNode(chargeTo)) throw notFound('Node');
    const server = serverFor(tools, nodeId, chargeTo, c.req.raw.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
}

/**
 * Call a harness tool over MCP the way the CLI does (one JSON-RPC request). Used by the placeholder
 * provider's test triggers and by tests. Returns the tool's text and whether it was an error.
 */
export async function callHarnessTool(
  url: string,
  name: 'fork_branches' | 'ask_node',
  args: Record<string, unknown>,
  fetchFn: (req: Request) => Response | Promise<Response> = fetch,
): Promise<{ text: string; isError: boolean }> {
  const res = await fetchFn(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (!body.result) throw new Error(`MCP call failed (${res.status}): ${body.error?.message ?? 'no result'}`);
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: body.result.isError === true };
}
