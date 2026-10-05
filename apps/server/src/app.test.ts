import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Attachment, BranchResult, ChatStreamEvent, DagNode, FolderGit, GraphResponse, MergePreview, ModelsResponse, NodeChanges,
  NodeDetail, Project, ProjectSummary,
} from '@harness/shared';
import { MANAGED_DIR } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { ChatRequest } from './dag/prompt.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent } from './llm/index.ts';
import { callHarnessTool } from './tools/harness.ts';
import { Workspaces } from './workspace.ts';

/**
 * Records the requests it receives and replies with fixed text.
 * A message containing "slow" waits until the test calls `release()`.
 */
class FakeProvider implements LLMProvider {
  readonly label = 'fake';
  readonly kind = 'fake';
  /** Most tests run read-only (no git); the file editing tests turn this on. */
  canEdit = false;

  async models(): Promise<ModelCatalog> {
    return {
      models: [{ id: 'big', efforts: ['low', 'high'] }, { id: 'small', efforts: [] }],
      defaultModel: 'big',
      defaultEffort: 'high',
      forkKeepsCache: true,
    };
  }
  requests: ChatRequest[] = [];
  private gate: (() => void) | null = null;
  /** The next reply fails with this error, after reporting its session. */
  failNext: Error | null = null;
  /** What suggestTitle answers (null: the provider can't suggest titles). */
  title: string | null = null;
  titleCalls = 0;

  release() {
    this.gate?.();
  }

  contexts: ReplyContext[] = [];

  async *streamReply(ctx: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const { request, message } = ctx;
    this.contexts.push(ctx);
    this.requests.push(request);
    yield { type: 'session', sessionId: 'session-1' };
    yield { type: 'model', model: 'fake-model' };
    const failure = this.failNext;
    this.failNext = null;
    if (failure) throw failure;
    yield { type: 'thinking' };
    if (message.includes('search')) {
      const call = { id: 'call-1', name: 'web_search', input: 'memory papers', status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      yield { type: 'tool', call: { ...call, status: 'done', results: [{ title: 'A paper', url: 'https://example.org/paper' }] } };
    }
    // "[write name]" writes a file named after the node's message count into its editable copy.
    const write = /\[write (\S+)\]/.exec(message);
    if (write && ctx.edit) writeFileSync(path.join(ctx.edit.dir, write[1]), `${write[1]} from ${ctx.nodeId}
`);
    // "[ask <id>]" shows an ask_node call, as the Claude Code provider reports it (title not known yet).
    const ask = /\[ask (\S+)\]/.exec(message);
    if (ask) yield { type: 'tool', call: { id: 'ask-1', name: 'ask_node', input: 'Q?', status: 'done', results: [], node: { id: ask[1], title: '' } } };
    yield { type: 'text', text: 'Hello ' };
    if (message.includes('slow')) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
        signal.addEventListener('abort', () => resolve());
      });
      if (signal.aborted) throw new Error('aborted');
    }
    yield { type: 'text', text: 'there' };
  }

  async draftResult({ request }: ReplyContext): Promise<BranchResult> {
    this.requests.push(request);
    return { findings: 'drafted', evidence: '', openQuestions: '', confidence: 'medium' };
  }

  asked: ReplyContext[] = [];

  async askNode(ctx: ReplyContext) {
    this.asked.push(ctx);
    return { answer: `answer from ${ctx.nodeId}`, usage: null };
  }

  suggestTitle = async (): Promise<string> => {
    this.titleCalls++;
    if (this.title === null) throw new Error('no title');
    return this.title;
  };
}

const RESULT: BranchResult = { findings: 'It works', evidence: 'tests', openQuestions: '', confidence: 'high' };

let llm: FakeProvider;
let app: ReturnType<typeof createApp>;
let rootId: string;

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

const parseEvents = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ChatStreamEvent);

async function chat(nodeId: string, content: string): Promise<ChatStreamEvent[]> {
  const res = await app.request(`/api/nodes/${nodeId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  return parseEvents(await res.text());
}

const detail = async (nodeId: string) => (await call<NodeDetail>('GET', `/nodes/${nodeId}`)).data;

/** Wait until the node's background reply has finished. */
async function settle(nodeId: string) {
  for (let i = 0; i < 100 && (await detail(nodeId)).running; i++) await new Promise((r) => setTimeout(r, 5));
}

/** Fork, and wait for the branches' first replies. */
async function fork(nodeId: string, prompts: string[], attachments: Attachment[][] = []) {
  const branches = prompts.map((prompt, i) => ({ prompt, attachments: attachments[i] ?? [] }));
  const { data } = await call<DagNode[]>('POST', `/nodes/${nodeId}/fork`, { branches });
  for (const child of data) await settle(child.id);
  return data;
}

let workspaces: Workspaces;
let repo: Repository;

beforeEach(() => {
  repo = new Repository(openDatabase(':memory:'));
  repo.createProject('default', 'Test', 'Main thread');
  llm = new FakeProvider();
  workspaces = new Workspaces(mkdtempSync(path.join(tmpdir(), 'harness-app-')));
  app = createApp({ repo, llm, workspaces });
  rootId = repo.listNodes('default')[0].id;
});

async function upload(name: string, text: string): Promise<{ status: number; data: Attachment }> {
  const form = new FormData();
  form.append('file', new File([text], name));
  const res = await app.request('/api/projects/default/uploads', { method: 'POST', body: form });
  return { status: res.status, data: (await res.json()) as Attachment };
}

describe('API', () => {
  it('reports health and the model label', async () => {
    expect((await call('GET', '/health')).data).toEqual({ ok: true, model: 'fake' });
  });

  it('returns the project graph with the root node', async () => {
    const { data } = await call<GraphResponse>('GET', '/projects/default/graph');
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0]).toMatchObject({
      title: 'Main thread', status: 'open', parentIds: [], messageCount: 0, lastRole: null, running: false,
    });
  });

  it('returns 404 for unknown projects and nodes', async () => {
    expect((await call('GET', '/projects/nope/graph')).status).toBe(404);
    expect((await call('GET', '/nodes/nope')).status).toBe(404);
  });

  it('streams a reply and stores both messages', async () => {
    const events = await chat(rootId, 'Hi');
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'delta', 'delta', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', message: { role: 'assistant', content: 'Hello there' } });

    const data = await detail(rootId);
    expect(data.node.sessionId).toBe('session-1'); // stored from the provider's session event
    expect(data.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello there'],
    ]);
  });

  it('streams tool calls, saves them, and passes their sources to later prompts', async () => {
    const events = await chat(rootId, 'Please search for memory papers');
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'tool', 'tool', 'delta', 'delta', 'done']);

    const done = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
    // offset: how much of the reply's text came before the call (here: none), so the chat shows it in place.
    expect(done.message.toolCalls).toEqual([
      { id: 'call-1', name: 'web_search', input: 'memory papers', status: 'done', results: [{ title: 'A paper', url: 'https://example.org/paper' }], offset: 0 },
    ]);

    await chat(rootId, 'Thanks');
    const history = llm.requests.at(-1)!.turns.map((t) => t.content).join('\n');
    expect(history).toContain('A paper (https://example.org/paper)');
  });

  it('rejects empty messages', async () => {
    expect((await call('POST', `/nodes/${rootId}/messages`, { content: '  ' })).status).toBe(400);
  });

  it('runs replies in the background: watch, working state, stop', async () => {
    const sending = chat(rootId, 'slow question'); // keeps running until released
    await new Promise((r) => setTimeout(r, 10));

    expect((await detail(rootId)).running).toBe(true);
    const graph = (await call<GraphResponse>('GET', '/projects/default/graph')).data;
    expect(graph.nodes[0]).toMatchObject({ running: true, lastRole: 'user', run: { activity: 'Writing' } });
    expect(Date.parse(graph.nodes[0].run!.startedAt)).toBeLessThanOrEqual(Date.now());
    expect((await call('POST', `/nodes/${rootId}/messages`, { content: 'another' })).status).toBe(409);

    // A second page attaches: it gets a snapshot of the reply so far, then the rest.
    const watching = Promise.resolve(app.request(`/api/nodes/${rootId}/stream`)).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 10));
    llm.release();

    const watched = parseEvents(await watching);
    expect(watched[0]).toMatchObject({ type: 'snapshot', text: 'Hello ', toolCalls: [], thinking: false });
    expect(watched[0]).toHaveProperty('startedAt');
    expect(watched.at(-1)).toMatchObject({ type: 'done', message: { content: 'Hello there' } });
    expect((await sending).at(-1)?.type).toBe('done');

    // Nothing running: watching returns `idle` right away.
    expect(parseEvents(await (await app.request(`/api/nodes/${rootId}/stream`)).text())).toEqual([{ type: 'idle' }]);

    // Stop keeps what arrived so far.
    const stopped = chat(rootId, 'slow again');
    await new Promise((r) => setTimeout(r, 10));
    await call('POST', `/nodes/${rootId}/stop`);
    expect((await stopped).at(-1)).toMatchObject({ type: 'done', message: { content: 'Hello ' } });
    expect((await detail(rootId)).running).toBe(false);
    expect((await detail(rootId)).run).toBeNull();
  });

  it('fork names each branch after its prompt and starts it working', async () => {
    await chat(rootId, 'Scope it');
    const longPrompt = `Compare retrieval methods for long conversations ${'and more detail '.repeat(10)}`;
    const [a, b] = await fork(rootId, ['Survey retrieval methods', longPrompt]);

    expect(a.title).toBe('Survey retrieval methods');
    expect(b.title.length).toBeLessThanOrEqual(81);
    expect(b.title.endsWith('…')).toBe(true);

    const root = await detail(rootId);
    expect(root.node.status).toBe('open');
    expect(root.childIds).toEqual([a.id, b.id]);
    expect(root.forks).toEqual([{ at: 2, childIds: [a.id, b.id] }]);
    expect(a).toMatchObject({ forkPoint: 2, forkSession: 'session-1' });

    // Each branch got its prompt as the first message, with the parent's context before it.
    const child = await detail(a.id);
    expect(child.inherited.map((i) => i.kind === 'message' && i.message.content)).toEqual(['Scope it', 'Hello there']);
    expect(child.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Survey retrieval methods'],
      ['assistant', 'Hello there'],
    ]);
    const sent = llm.requests.find((r) => r.turns.at(-1)?.content === 'Survey retrieval methods')!;
    expect(sent.turns[0].content).toBe('Scope it');
  });

  it('a forked node goes on in a copy of its session; its branches keep the fork point', async () => {
    await chat(rootId, 'Scope it');
    const [a] = await fork(rootId, ['Side question']);

    // The parent continues: its session is copied (forked), so the branch's fork point stays as it was.
    await chat(rootId, 'Main thread goes on');
    const parentRun = llm.contexts.findLast((c) => c.nodeId === rootId)!;
    expect(parentRun.session).toMatchObject({ mode: 'fork', sessionId: 'session-1', preamble: null });
    expect((await detail(a.id)).inherited).toHaveLength(2);

    // Forking again later: the new branch gets everything up to now.
    const [b] = await fork(rootId, ['Later question']);
    expect(b.forkPoint).toBe(4);
    expect((await detail(b.id)).inherited).toHaveLength(4);
    expect((await detail(rootId)).forks.map((f) => f.at)).toEqual([2, 4]);
  });

  it('drafts a result without saving it, then finishing saves it', async () => {
    const [a] = await fork(rootId, ['A question']);
    const draft = await call<BranchResult>('POST', `/nodes/${a.id}/result/draft`);
    expect(draft.data.findings).toBe('drafted');
    expect((await detail(a.id)).node.status).toBe('open');

    const finished = await call<DagNode>('PUT', `/nodes/${a.id}/result`, RESULT);
    expect(finished.data).toMatchObject({ status: 'finished', result: RESULT });
    expect((await call('POST', `/nodes/${a.id}/messages`, { content: 'more' })).status).toBe(409);
  });

  it('cannot draft a result for a branch without replies', async () => {
    const repoNode = (await call<DagNode>('POST', '/projects/default/reset')).data; // fresh root, no replies
    expect((await call('POST', `/nodes/${repoNode.id}/result/draft`)).status).toBe(400);
  });

  it('the root cannot be finished', async () => {
    expect((await call('PUT', `/nodes/${rootId}/result`, RESULT)).status).toBe(400);
  });

  it('merges finished branches and starts the merged node on its first message', async () => {
    await chat(rootId, 'Scope it');
    const [a, b, c] = await fork(rootId, ['secret transcript of A', 'B question', 'C question']);
    await call('PUT', `/nodes/${a.id}/result`, { ...RESULT, findings: 'A result' });
    await call('PUT', `/nodes/${b.id}/result`, { ...RESULT, findings: 'B result' });

    const body = (parentIds: string[]) => ({ parentIds, title: 'M', prompt: 'Synthesize' });
    expect((await call('POST', '/projects/default/merge', body([a.id, c.id]))).status).toBe(409);
    expect((await call('POST', '/projects/default/merge', body([a.id, a.id]))).status).toBe(400);

    const merged = await call<DagNode>('POST', '/projects/default/merge', body([a.id, b.id]));
    expect(merged.status).toBe(201);
    expect(merged.data.parentIds).toEqual([a.id, b.id]);
    await settle(merged.data.id);

    const d = await detail(merged.data.id);
    expect(d.inherited.map((i) => (i.kind === 'result' ? `result:${i.nodeTitle}` : i.message.content))).toEqual([
      'Scope it',
      'Hello there',
      'result:secret transcript of A',
      'result:B question',
    ]);
    expect(d.messages.map((m) => m.content)).toEqual(['Synthesize', 'Hello there']);

    const prompt = llm.requests.at(-1)!.turns.map((t) => t.content).join('\n');
    expect(prompt).toContain('A result');
    expect(prompt).not.toContain('Hello there\nsecret transcript of A'); // the branch transcript is not included
  });

  describe('harness MCP tools', () => {
    /** Call a tool the way the CLI does, through the app's MCP endpoint. */
    const tool = (nodeId: string, name: 'fork_branches' | 'ask_node', args: Record<string, unknown>) =>
      callHarnessTool(`http://localhost/api/mcp/${nodeId}`, name, args, (req) => app.request(req));

    it('offers fork_branches and ask_node to the CLI, never to web pages', async () => {
      const list = await app.request(`/api/mcp/${rootId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
      expect(tools.map((t) => t.name)).toEqual(['fork_branches', 'ask_node']);

      const fromPage = await app.request(`/api/mcp/${rootId}`, { method: 'POST', headers: { origin: 'https://example.org' }, body: '{}' });
      expect(fromPage.status).toBe(403);
      expect((await app.request('/api/mcp/nope', { method: 'POST', body: '{}' })).status).toBe(404);
    });

    it('gives each node its own endpoint when the server knows its address', async () => {
      await chat(rootId, 'Hi');
      expect(llm.contexts.at(-1)!.mcpUrl).toBeNull();

      app = createApp({ repo, llm, workspaces, serverUrl: 'http://127.0.0.1:8787' });
      await chat(rootId, 'Hi again');
      expect(llm.contexts.at(-1)!.mcpUrl).toBe(`http://127.0.0.1:8787/api/mcp/${rootId}`);
    });

    it('saves proposed branches with the reply; the graph counts them until the node is forked', async () => {
      const branches = [{ prompt: 'Look into X', title: 'X' }, { prompt: 'Look into Y' }];
      expect(await tool(rootId, 'fork_branches', { branches })).toMatchObject({ isError: true }); // nothing running

      const sending = chat(rootId, 'slow: fork for each option');
      await new Promise((r) => setTimeout(r, 10));
      expect(await tool(rootId, 'fork_branches', { branches: [branches[0]] })).toMatchObject({ isError: false });
      const answer = await tool(rootId, 'fork_branches', { branches }); // replaces the first proposal
      expect(answer.text).toContain('Proposed 2 branches');
      llm.release();
      await sending;

      const reply = (await detail(rootId)).messages.at(-1)!;
      expect(reply.forkProposal).toEqual({ branches: [{ prompt: 'Look into X', title: 'X' }, { prompt: 'Look into Y', title: null }] });
      const card = () => call<GraphResponse>('GET', '/projects/default/graph').then((r) => r.data.nodes.find((n) => n.id === rootId)!);
      expect((await card()).proposedBranches).toBe(2);

      await fork(rootId, ['Look into X']);
      expect((await card()).proposedBranches).toBe(0);
    });

    it('asks a node this one descends from, and only those', async () => {
      await chat(rootId, 'Scope it');
      const [a, b] = await fork(rootId, ['A question', 'B question']);
      await call('PUT', `/nodes/${a.id}/result`, { ...RESULT, findings: 'A result' });
      await call('PUT', `/nodes/${b.id}/result`, { ...RESULT, findings: 'B result' });
      const merged = (await call<DagNode>('POST', '/projects/default/merge', { parentIds: [a.id, b.id], prompt: 'Synthesize slowly' })).data;
      await new Promise((r) => setTimeout(r, 10)); // its reply is running (until released)

      // The merge note names the merged branches by id.
      const prompt = llm.requests.at(-1)!.turns.map((t) => t.content).join('\n');
      expect(prompt).toContain(`- "A question" (node ${a.id})`);

      const answer = await tool(merged.id, 'ask_node', { nodeId: a.id.slice(0, 8), question: 'What exactly?' });
      expect(answer).toEqual({ text: `answer from ${a.id}\n\n(2 of 3 free questions left in this reply; after that, questions need the user's approval.)`, isError: false });
      const asked = llm.asked[0];
      expect(asked.message).toContain('"Synthesis: A question + B question", asks this conversation a question');
      expect(asked.message.endsWith('What exactly?')).toBe(true);
      expect(asked.session).toMatchObject({ mode: 'resume', sessionId: 'session-1' }); // a's own session
      expect(asked.request.turns.map((t) => t.content)).toContain('A question'); // a's whole conversation

      // A sibling isn't an ancestor, and neither is the node itself.
      expect(await tool(a.id, 'ask_node', { nodeId: b.id, question: 'Q?' })).toMatchObject({ isError: true });
      expect(await tool(merged.id, 'ask_node', { nodeId: merged.id, question: 'Q?' })).toMatchObject({ isError: true });
      expect(llm.asked).toHaveLength(1);
      llm.release();
      await settle(merged.id);
    });

    describe('question limit', () => {
      /** A merged node whose first reply keeps running (until released), with A and B to ask. */
      async function mergedAndRunning() {
        await chat(rootId, 'Scope it');
        const [a, b] = await fork(rootId, ['A question', 'B question']);
        await call('PUT', `/nodes/${a.id}/result`, { ...RESULT, findings: 'A result' });
        await call('PUT', `/nodes/${b.id}/result`, { ...RESULT, findings: 'B result' });
        const merged = (await call<DagNode>('POST', '/projects/default/merge', { parentIds: [a.id, b.id], prompt: 'Synthesize slowly' })).data;
        await new Promise((r) => setTimeout(r, 10));
        return { a, b, merged };
      }
      const waiting = async (nodeId: string) => (await detail(nodeId)).run?.approval ?? null;
      const until = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
      };

      it('allows a few questions per message, then waits for the user; allowing frees them again', async () => {
        app = createApp({ repo, llm, workspaces, askLimit: 1 });
        const { a, b, merged } = await mergedAndRunning();

        const first = await tool(merged.id, 'ask_node', { nodeId: a.id, question: 'Q1' });
        expect(first.text).toContain('(0 of 1 free questions left in this reply');

        // Over the limit: both questions wait together for one decision.
        const second = tool(merged.id, 'ask_node', { nodeId: a.id, question: 'Q2' });
        const third = tool(merged.id, 'ask_node', { nodeId: b.id, question: 'Q3' });
        await until(async () => (await waiting(merged.id))?.asks.length === 2);
        expect(await waiting(merged.id)).toMatchObject({
          asks: [{ nodeTitle: 'A question', from: null, question: 'Q2' }, { nodeTitle: 'B question', from: null, question: 'Q3' }],
          limit: 1,
        });
        const card = (await call<GraphResponse>('GET', '/projects/default/graph')).data.nodes.find((n) => n.id === merged.id)!;
        expect(card.run).toMatchObject({ activity: 'Waiting for your approval' });
        expect(llm.asked).toHaveLength(1);

        expect((await call('POST', `/nodes/${merged.id}/asks`, { allow: true })).status).toBe(200);
        expect((await second).text).toContain(`answer from ${a.id}`);
        expect((await third).text).toContain(`answer from ${b.id}`);
        expect(await waiting(merged.id)).toBeNull();

        // Denied: the model hears it and carries on; the next question asks the user again.
        const fourth = tool(merged.id, 'ask_node', { nodeId: a.id, question: 'Q4' });
        await until(async () => (await waiting(merged.id)) !== null);
        await call('POST', `/nodes/${merged.id}/asks`, { allow: false });
        expect(await fourth).toMatchObject({ isError: true, text: expect.stringContaining('declined') });
        const fifth = tool(merged.id, 'ask_node', { nodeId: a.id, question: 'Q5' });
        await until(async () => (await waiting(merged.id)) !== null);
        expect((await waiting(merged.id))?.asks).toHaveLength(1);

        // The reply ends: whatever still waits is refused.
        llm.release();
        expect(await fifth).toMatchObject({ isError: true });
        await settle(merged.id);
        expect((await call('POST', `/nodes/${merged.id}/asks`, { allow: true })).status).toBe(409);
        expect(llm.asked).toHaveLength(3);
      });

      it('tells the model the user is probably away when nobody answers', async () => {
        app = createApp({ repo, llm, workspaces, askLimit: 0, askApprovalTimeoutMs: 30 });
        const { a, merged } = await mergedAndRunning();
        const answer = await tool(merged.id, 'ask_node', { nodeId: a.id, question: 'Q' });
        expect(answer).toMatchObject({ isError: true, text: expect.stringContaining('probably away') });
        expect(await waiting(merged.id)).toBeNull();
        llm.release();
        await settle(merged.id);
      });

      it("counts a question a node asks while answering against the reply that asked it", async () => {
        app = createApp({ repo, llm, workspaces, askLimit: 1 });
        const { a, merged } = await mergedAndRunning();
        // a, answering the merged node, asks the root: the merged node's free question is used up.
        const nested = await tool(`${a.id}?for=${merged.id}`, 'ask_node', { nodeId: rootId, question: 'Q' });
        expect(nested.text).toContain('(0 of 1 free');
        // The next one waits on the merged node's reply, saying who asks.
        const next = tool(`${a.id}?for=${merged.id}`, 'ask_node', { nodeId: rootId, question: 'Q2' });
        await until(async () => (await waiting(merged.id)) !== null);
        expect((await waiting(merged.id))?.asks).toEqual([{ nodeTitle: 'Main thread', from: 'A question', question: 'Q2' }]);
        await call('POST', `/nodes/${merged.id}/asks`, { allow: false });
        expect(await next).toMatchObject({ isError: true });
        llm.release();
        await settle(merged.id);
        // With no reply running on the node it would count against, nothing can be asked.
        expect(await tool(`${a.id}?for=${merged.id}`, 'ask_node', { nodeId: rootId, question: 'Q3' })).toMatchObject({ isError: true });
      });
    });

    it('shows the asked node by title on the tool call', async () => {
      await chat(rootId, 'Scope it');
      const [a] = await fork(rootId, ['A question']);
      await chat(a.id, `[ask ${rootId.slice(0, 8)}]`);
      expect((await detail(a.id)).messages.at(-1)!.toolCalls[0].node).toEqual({ id: rootId, title: 'Main thread' });
    });
  });

  it('reset deletes all nodes and messages and leaves a fresh root', async () => {
    await chat(rootId, 'Scope it');
    await fork(rootId, ['A', 'B']);

    const { status, data: newRoot } = await call<DagNode>('POST', '/projects/default/reset');
    expect(status).toBe(200);
    expect(newRoot).toMatchObject({ title: 'Main thread', status: 'open', parentIds: [], sessionId: null });

    const graph = (await call<GraphResponse>('GET', '/projects/default/graph')).data;
    expect(graph.nodes.map((n) => [n.id, n.messageCount])).toEqual([[newRoot.id, 0]]);
    expect((await call('GET', `/nodes/${rootId}`)).status).toBe(404);
  });

  it("uploads files into the project's managed uploads folder and attaches them to a message", async () => {
    const { status, data: paper } = await upload('paper.tex', '\\section{Intro}');
    expect(status).toBe(201);
    expect(paper.name).toBe('paper.tex');
    expect(path.basename(path.dirname(paper.path))).toBe('uploads');
    expect(readFileSync(paper.path, 'utf8')).toBe('\\section{Intro}');

    const res = await app.request(`/api/nodes/${rootId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Review my draft', attachments: [paper] }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // Saved with the message, and the model is told where to read it, running in the project folder.
    const saved = (await detail(rootId)).messages[0];
    expect(saved.attachments).toEqual([paper]);
    const ctx = llm.contexts.at(-1)!;
    expect(ctx.message).toContain('Review my draft');
    expect(ctx.message).toContain(paper.path);
    expect(path.resolve(paper.path).startsWith(path.resolve(ctx.workDir))).toBe(true);
    expect(existsSync(path.join(ctx.workDir, MANAGED_DIR, '.gitignore'))).toBe(true);
    // Later prompts keep the note, so a replay (or another provider) still knows about the file.
    expect(llm.requests.at(-1)!.turns[0].content).toContain(paper.path);
  });

  it('uploads a folder and tells the model to explore it', async () => {
    const form = new FormData();
    form.append('name', 'thesis');
    for (const [rel, text] of [['main.tex', '\\begin{document}'], ['chapters/one.tex', 'Chapter one']]) {
      form.append('path', rel);
      form.append('file', new File([text], rel.split('/').pop()!));
    }
    const res = await app.request('/api/projects/default/uploads/folder', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const folder = (await res.json()) as Attachment;
    expect(folder).toMatchObject({ name: 'thesis', kind: 'folder', fileCount: 2 });
    expect(readFileSync(path.join(folder.path, 'chapters', 'one.tex'), 'utf8')).toBe('Chapter one');

    const sent = await app.request(`/api/nodes/${rootId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Summarize my thesis', attachments: [folder] }),
    });
    await sent.text();
    const message = llm.contexts.at(-1)!.message;
    expect(message).toContain(`${folder.path} (folder, 2 files)`);
    expect(message).toContain('Glob');
  });

  it('rejects a folder upload whose paths and files do not match', async () => {
    const form = new FormData();
    form.append('name', 'broken');
    form.append('path', 'a.txt');
    const res = await app.request('/api/projects/default/uploads/folder', { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('refuses attachments that are not uploads of this project', async () => {
    const res = await call('POST', `/nodes/${rootId}/messages`, {
      content: 'Read this',
      attachments: [{ name: 'hosts', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', size: 1 }],
    });
    expect(res.status).toBe(400);
    expect((await detail(rootId)).messages).toHaveLength(0);
  });

  it('rejects an upload without a file', async () => {
    const res = await app.request('/api/projects/default/uploads', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });

  it('backs up before a reset', async () => {
    const labels: string[] = [];
    const withBackup = createApp({ repo, llm, workspaces, backup: (label) => (labels.push(label), 'backup.db') });
    expect((await withBackup.request('/api/projects/default/reset', { method: 'POST' })).status).toBe(200);
    expect(labels).toEqual(['before-reset']);
  });

  it('deletes nothing if the backup before a reset fails', async () => {
    await chat(rootId, 'Precious research');
    const failing = createApp({ repo, llm, workspaces, backup: () => { throw new Error('disk full'); } });
    const res = await failing.request('/api/projects/default/reset', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('nothing was deleted');
    expect((await detail(rootId)).messages.map((m) => m.content)).toContain('Precious research');
  });

  it('archives and unarchives a project', async () => {
    expect((await call<Project>('PATCH', '/projects/default', { archived: true })).data).toMatchObject({ archived: true, name: 'Test' });
    expect((await call<ProjectSummary[]>('GET', '/projects')).data[0].archived).toBe(true);
    expect((await call<Project>('PATCH', '/projects/default', { archived: false })).data.archived).toBe(false);
    expect((await call('PATCH', '/projects/default', {})).status).toBe(400);
  });

  it('deletes a project after a backup, leaving the others and its folder', async () => {
    const other = (await call<Project>('POST', '/projects', { name: 'Other' })).data;
    await chat(rootId, 'Some research');
    const folder = workspaces.prepare(repo.getProject('default')!);
    const labels: string[] = [];
    const withBackup = createApp({ repo, llm, workspaces, backup: (label) => (labels.push(label), 'backup.db') });
    expect((await withBackup.request('/api/projects/default', { method: 'DELETE' })).status).toBe(200);
    expect(labels).toEqual(['before-delete-project']);
    expect(repo.getProject('default')).toBeNull();
    expect(repo.getNode(rootId)).toBeNull();
    expect(repo.getProject(other.id)).not.toBeNull();
    expect(existsSync(folder)).toBe(true);
  });

  it('deletes nothing if the backup before deleting a project fails', async () => {
    const failing = createApp({ repo, llm, workspaces, backup: () => { throw new Error('disk full'); } });
    expect((await failing.request('/api/projects/default', { method: 'DELETE' })).status).toBe(500);
    expect(repo.getProject('default')).not.toBeNull();
  });

  it('renames a node; prompts keep the title it was created with', async () => {
    await chat(rootId, 'Scope it');
    const [a] = await fork(rootId, ['Survey retrieval methods']);
    const { data } = await call<DagNode>('PATCH', `/nodes/${a.id}`, { title: 'Renamed' });
    expect(data).toMatchObject({ title: 'Renamed', titleSource: 'user', promptTitle: 'Survey retrieval methods' });

    await chat(a.id, 'More');
    const prompt = llm.requests.at(-1)!.turns.map((t) => t.content).join('\n');
    expect(prompt).toContain('A new branch starts here: "Survey retrieval methods"');
    expect(prompt).not.toContain('Renamed');
  });

  it('lets a small model title a node after its first reply, never over a user title', async () => {
    llm.title = '"Retrieval Methods Survey."';
    await chat(rootId, 'Scope it');
    const titleOf = async (id: string) => (await detail(id)).node;
    for (let i = 0; i < 50 && (await titleOf(rootId)).titleSource === 'prompt'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await titleOf(rootId)).toMatchObject({ title: 'Retrieval Methods Survey', titleSource: 'model', promptTitle: 'Main thread' });

    // Only after the first reply.
    await chat(rootId, 'Again');
    expect(llm.titleCalls).toBe(1);

    // A branch the user renamed before its first reply finished keeps the user's title.
    const [a] = await call<DagNode[]>('POST', `/nodes/${rootId}/fork`, { branches: [{ prompt: 'slow branch' }] }).then((r) => r.data);
    await call('PATCH', `/nodes/${a.id}`, { title: 'Mine' });
    llm.release();
    await settle(a.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await titleOf(a.id)).toMatchObject({ title: 'Mine', titleSource: 'user' });
  });

  it('suggests a title on request without saving it', async () => {
    llm.title = 'Suggested Title';
    await chat(rootId, 'Scope it');
    const { data } = await call<{ title: string }>('POST', `/nodes/${rootId}/title/suggest`);
    expect(data.title).toBe('Suggested Title');
  });

  it('reports a reached usage limit, keeps no session, and retries the message', async () => {
    llm.failNext = new Error("You've hit your limit · resets 5pm");
    const events = await chat(rootId, 'Scope it');
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'usage_limit', error: expect.stringContaining('usage limit') });

    let graph = (await call<GraphResponse>('GET', '/projects/default/graph')).data;
    expect(graph.usage).toMatchObject({ status: 'reached' });
    expect(graph.nodes[0]).toMatchObject({ lastRole: 'user', sessionId: null }); // a fresh start on retry

    expect((await call('POST', `/nodes/${rootId}/retry`)).status).toBe(200);
    await settle(rootId);
    const d = await detail(rootId);
    expect(d.messages.map((m) => [m.role, m.content])).toEqual([['user', 'Scope it'], ['assistant', 'Hello there']]);
    expect(d.node.sessionId).toBe('session-1');
    expect(llm.contexts.at(-1)!.message).toBe('Scope it'); // the same message, sent once more
    graph = (await call<GraphResponse>('GET', '/projects/default/graph')).data;
    expect(graph.usage).toBeNull(); // a reply went through

    // Nothing to retry once the last message has its reply.
    expect((await call('POST', `/nodes/${rootId}/retry`)).status).toBe(409);
  });

  it('says plainly when Claude is not signed in', async () => {
    llm.failNext = new Error('Invalid API key · Please run /login');
    const events = await chat(rootId, 'Scope it');
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'auth', error: expect.stringContaining('not signed in') });
  });

  it('forks with files for each branch', async () => {
    await chat(rootId, 'Scope it');
    const { data: paper } = await upload('paper.tex', 'x');
    const [a, b] = await fork(rootId, ['Read the paper', 'No files'], [[paper]]);
    expect((await detail(a.id)).messages[0].attachments).toEqual([paper]);
    expect((await detail(b.id)).messages[0].attachments).toEqual([]);
    expect(llm.contexts.find((c) => c.nodeId === a.id)!.message).toContain(paper.path);

    const bad = await call('POST', `/nodes/${b.id}/fork`, {
      branches: [{ prompt: 'x', attachments: [{ name: 'hosts', path: 'C:\\Windows\\hosts', size: 1 }] }],
    });
    expect(bad.status).toBe(400);
  });

  it('creates projects, each with its own root, and lists the most recently used first', async () => {
    const { status, data: test } = await call<Project>('POST', '/projects', { name: 'Testing' });
    expect(status).toBe(201);
    expect(test.name).toBe('Testing');
    // Its folder is named after it, in the data folder's projects/.
    expect([path.basename(path.dirname(test.folder!)), path.basename(test.folder!)]).toEqual(['projects', 'Testing']);

    const graph = (await call<GraphResponse>('GET', `/projects/${test.id}/graph`)).data;
    expect(graph.nodes.map((n) => [n.title, n.parentIds])).toEqual([['Main thread', []]]);
    await chat(graph.nodes[0].id, 'Hi'); // used last, so listed first

    const list = (await call<ProjectSummary[]>('GET', '/projects')).data;
    expect(list.map((p) => [p.name, p.nodeCount, p.running])).toEqual([['Testing', 1, false], ['Test', 1, false]]);
    // The other project is untouched.
    expect((await call<GraphResponse>('GET', '/projects/default/graph')).data.nodes[0].messageCount).toBe(0);

    const renamed = await call<Project>('PATCH', `/projects/${test.id}`, { name: 'Sandbox' });
    expect(renamed.data.name).toBe('Sandbox');
    expect((await call('POST', '/projects', { name: '  ' })).status).toBe(400);
  });

  it("shows the folder a new project would get, and sets the root's model and effort", async () => {
    const preview = (await call<{ path: string }>('GET', `/projects/new-folder?name=${encodeURIComponent('Second paper')}`)).data;
    const { data } = await call<Project>('POST', '/projects', { name: 'Second paper', model: 'big', effort: 'low' });
    expect(data.folder).toBe(preview.path);
    const [root] = (await call<GraphResponse>('GET', `/projects/${data.id}/graph`)).data.nodes;
    expect([root.model, root.effort]).toEqual(['big', 'low']);
    // Checked against the provider's list, before anything is created.
    expect((await call('POST', '/projects', { name: 'Bad', model: 'big', effort: 'max' })).status).toBe(400);
    expect((await call<ProjectSummary[]>('GET', '/projects')).data.some((p) => p.name === 'Bad')).toBe(false);
  });

  it('creates a project in a folder the user chose, and refuses unsuitable folders', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'harness-thesis-'));
    const { status, data } = await call<Project>('POST', '/projects', { name: 'Thesis', folder });
    expect(status).toBe(201);
    expect(path.resolve(data.folder!)).toBe(path.resolve(realpathSync(folder)));
    expect(existsSync(path.join(folder, MANAGED_DIR, '.gitignore'))).toBe(true);

    for (const bad of ['relative/path', path.join(folder, 'missing'), path.parse(folder).root]) {
      expect((await call('POST', '/projects', { name: 'Bad', folder: bad })).status).toBe(400);
    }
  });

  it('opens the folder dialog on this machine and returns the chosen folder', async () => {
    const asked: unknown[] = [];
    const withPicker = createApp({ repo, llm, workspaces, pickFolder: async (opts) => (asked.push(opts), 'D:\\Thesis') });
    const res = await withPicker.request('/api/system/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Working folder' }),
    });
    expect(await res.json()).toEqual({ path: 'D:\\Thesis' });
    expect(asked).toEqual([{ title: 'Working folder' }]);
  });

  it('gives a merged node a default title the model may replace, unless the user wrote one', async () => {
    await chat(rootId, 'Scope it');
    const [a, b] = await fork(rootId, ['A', 'B']);
    await call('PUT', `/nodes/${a.id}/result`, RESULT);
    await call('PUT', `/nodes/${b.id}/result`, RESULT);
    const auto = await call<DagNode>('POST', '/projects/default/merge', { parentIds: [a.id, b.id], prompt: 'Go' });
    expect(auto.data).toMatchObject({ title: 'Synthesis: A + B', titleSource: 'prompt' });
    await settle(auto.data.id);
  });
  describe('read position', () => {
    const unreadOf = async (id: string) =>
      (await call<GraphResponse>('GET', '/projects/default/graph')).data.nodes.find((n) => n.id === id)!.unread;

    it('counts unread replies per node and moves forward only', async () => {
      await chat(rootId, 'First');
      await chat(rootId, 'Second');
      const [first, firstReply, second, secondReply] = (await detail(rootId)).messages;
      expect((await detail(rootId)).node.readUpto).toBeNull();
      expect(await unreadOf(rootId)).toBe(2);

      expect((await call('PUT', `/nodes/${rootId}/read`, { messageId: firstReply.id })).status).toBe(200);
      expect(await unreadOf(rootId)).toBe(1);

      await call('PUT', `/nodes/${rootId}/read`, { messageId: secondReply.id });
      expect(await unreadOf(rootId)).toBe(0);

      // An older message never moves it back.
      await call('PUT', `/nodes/${rootId}/read`, { messageId: first.id });
      await call('PUT', `/nodes/${rootId}/read`, { messageId: second.id });
      expect((await detail(rootId)).node.readUpto).toBe(secondReply.id);
    });

    it('rejects messages that are not in the node', async () => {
      await chat(rootId, 'Hi');
      const [other] = await fork(rootId, ['Other']);
      const otherMessage = (await detail(other.id)).messages[0];
      expect((await call('PUT', `/nodes/${rootId}/read`, { messageId: otherMessage.id })).status).toBe(404);
      expect((await call('PUT', `/nodes/${rootId}/read`, { messageId: 'nope' })).status).toBe(404);
      expect((await detail(rootId)).node.readUpto).toBeNull();
    });

    it('flags the reply of a new branch as unread', async () => {
      await chat(rootId, 'Scope it');
      const [branch] = await fork(rootId, ['Look into A']);
      expect(await unreadOf(branch.id)).toBe(1);
    });
  });
  describe('model settings', () => {
    it("lists the provider's models", async () => {
      const { data } = await call<ModelsResponse>('GET', '/models');
      expect(data).toMatchObject({ provider: 'fake', defaultModel: 'big', defaultEffort: 'high', forkKeepsCache: true });
      expect(data.models.map((m) => m.id)).toEqual(['big', 'small']);
    });

    it("changes a node's model and effort for its next replies, checked against the list", async () => {
      const put = (body: object) => call<DagNode>('PUT', `/nodes/${rootId}/model`, body);
      expect((await put({ model: 'nope', effort: null })).status).toBe(400);
      expect((await put({ model: 'big', effort: 'max' })).status).toBe(400); // big takes low or high
      expect((await put({ model: 'small', effort: 'low' })).status).toBe(400); // small has no effort
      const ok = await put({ model: 'big', effort: 'low' });
      expect(ok.status).toBe(200);
      expect(ok.data).toMatchObject({ model: 'big', effort: 'low' });

      await chat(rootId, 'Hi');
      expect(llm.contexts.at(-1)).toMatchObject({ model: 'big', effort: 'low' });
      expect((await detail(rootId)).messages.at(-1)!.model).toBe('fake-model'); // what the provider reported

      expect((await put({ model: null, effort: null })).data).toMatchObject({ model: null, effort: null });
    });

    it("branches copy their parent's settings unless given their own; changing the parent later doesn't reach them", async () => {
      await call('PUT', `/nodes/${rootId}/model`, { model: 'big', effort: 'high' });
      await chat(rootId, 'Scope it');
      const { data } = await call<DagNode[]>('POST', `/nodes/${rootId}/fork`, {
        branches: [{ prompt: 'same' }, { prompt: 'other', model: 'small', effort: null }, { prompt: 'bad', model: 'nope' }],
      });
      expect(data).toEqual({ error: 'Unknown model "nope".' });
      expect((await detail(rootId)).node.status).toBe('open'); // nothing was created

      const created = await call<DagNode[]>('POST', `/nodes/${rootId}/fork`, {
        branches: [{ prompt: 'same' }, { prompt: 'other', model: 'small', effort: null }],
      });
      const [same, other] = created.data;
      for (const n of created.data) await settle(n.id);
      expect(llm.contexts.at(-1)).toMatchObject({ model: 'small', effort: null });
      expect(same).toMatchObject({ model: 'big', effort: 'high' });
      expect(other).toMatchObject({ model: 'small', effort: null });
      expect((await call('PUT', `/nodes/${rootId}/model`, { model: 'small', effort: null })).status).toBe(200);
      expect((await detail(same.id)).node).toMatchObject({ model: 'big', effort: 'high' });
    });

    it('a merged node takes its branches\' setting; with different models, the first by name', async () => {
      await call('PUT', `/nodes/${rootId}/model`, { model: 'big', effort: 'low' });
      await chat(rootId, 'Scope it');
      const [a, b, c] = await fork(rootId, ['A', 'B', 'C']);
      for (const n of [a, b, c]) await call('PUT', `/nodes/${n.id}/result`, RESULT);
      const merge = async (ids: string[]) =>
        (await call<DagNode>('POST', '/projects/default/merge', { parentIds: ids, prompt: 'Synthesize' })).data;

      const same = await merge([a.id, b.id]);
      expect(same).toMatchObject({ model: 'big', effort: 'low' });
      await settle(same.id);

      // c is switched to "small" before finishing (via the database: finished nodes can't change).
      repo.setModelSettings(c.id, 'small', null);
      const mixed = await merge([c.id, a.id]);
      expect(mixed).toMatchObject({ model: 'big', effort: 'low' }); // "big" < "small"
      await settle(mixed.id);

      // Or the one chosen in the merge dialog (checked like any other).
      const body = (extra: object) => ({ parentIds: [a.id, c.id], prompt: 'Synthesize', ...extra });
      expect((await call('POST', '/projects/default/merge', body({ model: 'nope' }))).status).toBe(400);
      const chosen = await call<DagNode>('POST', '/projects/default/merge', body({ model: 'small', effort: null }));
      expect(chosen.data).toMatchObject({ model: 'small', effort: null });
      await settle(chosen.data.id);
    });
  });

  it('names a branch after its given title, else after its prompt', async () => {
    await chat(rootId, 'Scope it');
    const { data } = await call<DagNode[]>('POST', `/nodes/${rootId}/fork`, {
      branches: [
        { prompt: 'Explain this direction.\n\nUse a hybrid argument', title: 'Use a hybrid argument' },
        { prompt: 'Plain prompt becomes the title' },
      ],
    });
    expect(data.map((n) => n.title)).toEqual(['Use a hybrid argument', 'Plain prompt becomes the title']);
    expect(data.map((n) => n.promptTitle)).toEqual(['Use a hybrid argument', 'Plain prompt becomes the title']);
    for (const child of data) await settle(child.id);
  });

  describe('file editing', () => {
    /** Wait for a reply, including the git work around it (slower than the fake model). */
    async function idle(nodeId: string) {
      for (let i = 0; i < 400 && (await detail(nodeId)).running; i++) await new Promise((r) => setTimeout(r, 25));
    }
    const projectFolder = () => workspaces.folderOf(repo.getProject('default')!);

    it('gives each node its own copy, and applies its changes', async () => {
      llm.canEdit = true;
      expect((await call<ModelsResponse>('GET', '/models')).data.canEdit).toBe(true);

      await chat(rootId, 'Start [write notes.md]');
      await idle(rootId);
      const root = (await detail(rootId)).node;
      expect(root).toMatchObject({ gitBranch: expect.stringMatching(/^harness\//), filesChanged: 1 });
      expect(llm.contexts.at(-1)!.message).toContain('Your own copy of the project is at');
      expect(llm.contexts.at(-1)!.edit!.dir).toContain(path.join(MANAGED_DIR, 'work'));
      expect(existsSync(path.join(projectFolder(), 'notes.md'))).toBe(false);

      await chat(rootId, 'More');
      await idle(rootId);
      expect(llm.contexts.at(-1)!.message).toBe('More'); // told once

      const changes = (await call<NodeChanges>('GET', `/nodes/${rootId}/changes`)).data;
      expect(changes.files.map((f) => f.path)).toEqual(['notes.md']);
      expect((await call('POST', `/nodes/${rootId}/apply`)).status).toBe(200);
      expect(readFileSync(path.join(projectFolder(), 'notes.md'), 'utf8')).toContain('notes.md from');
      expect((await detail(rootId)).node.filesChanged).toBe(0);
    });

    it('starts branches from the parent’s files and previews merges', async () => {
      llm.canEdit = true;
      await chat(rootId, 'Start [write shared.md]');
      await idle(rootId);
      const { data: kids } = await call<DagNode[]>('POST', `/nodes/${rootId}/fork`, {
        branches: [{ prompt: 'A [write shared.md]', title: 'A' }, { prompt: 'B [write shared.md]', title: 'B' }],
      });
      for (const k of kids) await idle(k.id);
      const dirs = llm.contexts.slice(-2).map((c) => c.edit!.dir);
      expect(new Set(dirs).size).toBe(2);
      for (const k of kids) expect((await detail(k.id)).node.filesChanged).toBe(1);

      for (const k of kids) await call('PUT', `/nodes/${k.id}/result`, RESULT);
      const preview = (await call<MergePreview>('POST', '/projects/default/merge/preview', { parentIds: kids.map((k) => k.id) })).data;
      expect(preview.conflicts).toEqual(['shared.md']);

      const merged = (await call<DagNode>('POST', '/projects/default/merge', { parentIds: kids.map((k) => k.id), prompt: 'Combine' })).data;
      await idle(merged.id);
      const first = llm.contexts.at(-1)!;
      expect(first.message).toContain('conflict markers');
      expect(readFileSync(path.join(first.edit!.dir, 'shared.md'), 'utf8')).toContain('<<<<<<<');
    });

    it('checks a chosen folder, then makes it a repository when the project is created', async () => {
      const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-chosen-')));
      writeFileSync(path.join(folder, 'paper.tex'), 'hello');
      const check = await call<FolderGit>('POST', '/projects/check-folder', { folder });
      expect(check.data).toMatchObject({ repository: false, uncommitted: false });
      expect(check.data.branch).toBeTruthy(); // the branch git init will create
      expect((await call('POST', '/projects/check-folder', { folder: 'relative/path' })).status).toBe(400);

      expect((await call('POST', '/projects', { name: 'Paper', folder })).status).toBe(201);
      expect((await call<FolderGit>('POST', '/projects/check-folder', { folder })).data)
        .toEqual({ repository: true, branch: check.data.branch, uncommitted: false });
    });

    it('runs read-only with a provider that can’t edit', async () => {
      await chat(rootId, 'Hi [write x.md]');
      expect(llm.contexts.at(-1)!.edit).toBeNull();
      expect((await detail(rootId)).node.gitBranch).toBeNull();
      expect((await call('GET', `/nodes/${rootId}/changes`)).data).toBeNull();
    });
  });
});
