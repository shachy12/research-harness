import type { BranchResult, ChatStreamEvent, DagNode, GraphResponse, NodeDetail } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { ChatRequest } from './dag/prompt.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import type { LLMProvider, ReplyContext, ReplyEvent } from './llm/index.ts';

/**
 * Records the requests it receives and replies with fixed text.
 * A message containing "slow" waits until the test calls `release()`.
 */
class FakeProvider implements LLMProvider {
  readonly label = 'fake';
  requests: ChatRequest[] = [];
  private gate: (() => void) | null = null;

  release() {
    this.gate?.();
  }

  async *streamReply({ request, message }: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    this.requests.push(request);
    yield { type: 'session', sessionId: 'session-1' };
    yield { type: 'thinking' };
    if (message.includes('search')) {
      const call = { id: 'call-1', name: 'web_search', input: 'memory papers', status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      yield { type: 'tool', call: { ...call, status: 'done', results: [{ title: 'A paper', url: 'https://example.org/paper' }] } };
    }
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
async function fork(nodeId: string, prompts: string[]) {
  const { data } = await call<DagNode[]>('POST', `/nodes/${nodeId}/fork`, { prompts });
  for (const child of data) await settle(child.id);
  return data;
}

beforeEach(() => {
  const repo = new Repository(openDatabase(':memory:'));
  repo.createProject('default', 'Test', 'Main thread');
  llm = new FakeProvider();
  app = createApp({ repo, llm });
  rootId = repo.listNodes('default')[0].id;
});

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
    expect(done.message.toolCalls).toEqual([
      { id: 'call-1', name: 'web_search', input: 'memory papers', status: 'done', results: [{ title: 'A paper', url: 'https://example.org/paper' }] },
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
    expect(graph.nodes[0]).toMatchObject({ running: true, lastRole: 'user' });
    expect((await call('POST', `/nodes/${rootId}/messages`, { content: 'another' })).status).toBe(409);

    // A second page attaches: it gets a snapshot of the reply so far, then the rest.
    const watching = Promise.resolve(app.request(`/api/nodes/${rootId}/stream`)).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 10));
    llm.release();

    const watched = parseEvents(await watching);
    expect(watched[0]).toEqual({ type: 'snapshot', text: 'Hello ', toolCalls: [], thinking: false });
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
  });

  it('fork names each branch after its prompt and starts it working', async () => {
    await chat(rootId, 'Scope it');
    const longPrompt = `Compare retrieval methods for long conversations ${'and more detail '.repeat(10)}`;
    const [a, b] = await fork(rootId, ['Survey retrieval methods', longPrompt]);

    expect(a.title).toBe('Survey retrieval methods');
    expect(b.title.length).toBeLessThanOrEqual(81);
    expect(b.title.endsWith('…')).toBe(true);

    const root = await detail(rootId);
    expect(root.node.status).toBe('frozen');
    expect(root.childIds).toEqual([a.id, b.id]);
    expect((await call('POST', `/nodes/${rootId}/messages`, { content: 'more' })).status).toBe(409);

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

  it('renames a node', async () => {
    const { data } = await call<DagNode>('PATCH', `/nodes/${rootId}`, { title: 'Renamed' });
    expect(data.title).toBe('Renamed');
  });
});
