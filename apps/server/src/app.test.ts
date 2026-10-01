import type { BranchResult, ChatStreamEvent, DagNode, GraphResponse, NodeDetail } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { ChatRequest } from './dag/prompt.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import type { LLMProvider, ReplyContext, ReplyEvent } from './llm/index.ts';

/** Records the requests it receives and replies with fixed text. */
class FakeProvider implements LLMProvider {
  readonly label = 'fake';
  requests: ChatRequest[] = [];

  async *streamReply({ request }: ReplyContext): AsyncIterable<ReplyEvent> {
    this.requests.push(request);
    yield { type: 'session', sessionId: 'session-1' };
    yield { type: 'thinking' };
    if (request.turns.at(-1)?.content.includes('search')) {
      const call = { id: 'call-1', name: 'web_search', input: 'memory papers', status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      yield { type: 'tool', call: { ...call, status: 'done', results: [{ title: 'A paper', url: 'https://example.org/paper' }] } };
    }
    yield { type: 'text', text: 'Hello ' };
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

async function chat(nodeId: string, content: string): Promise<ChatStreamEvent[]> {
  const res = await app.request(`/api/nodes/${nodeId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ChatStreamEvent);
}

const fork = async (nodeId: string, titles: string[]) =>
  (await call<DagNode[]>('POST', `/nodes/${nodeId}/fork`, { titles })).data;

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
    expect(data.nodes[0]).toMatchObject({ title: 'Main thread', status: 'open', parentIds: [], messageCount: 0 });
  });

  it('returns 404 for unknown projects and nodes', async () => {
    expect((await call('GET', '/projects/nope/graph')).status).toBe(404);
    expect((await call('GET', '/nodes/nope')).status).toBe(404);
  });

  it('streams a reply and stores both messages', async () => {
    const events = await chat(rootId, 'Hi');
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'delta', 'delta', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', message: { role: 'assistant', content: 'Hello there' } });

    const { data } = await call<NodeDetail>('GET', `/nodes/${rootId}`);
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

  it('forking freezes the parent and children inherit its messages', async () => {
    await chat(rootId, 'Scope it');
    const [a, b] = await fork(rootId, ['A', 'B']);

    const root = (await call<NodeDetail>('GET', `/nodes/${rootId}`)).data;
    expect(root.node.status).toBe('frozen');
    expect(root.childIds).toEqual([a.id, b.id]);
    expect((await call('POST', `/nodes/${rootId}/messages`, { content: 'more' })).status).toBe(409);

    const child = (await call<NodeDetail>('GET', `/nodes/${a.id}`)).data;
    expect(child.inherited.map((i) => i.kind === 'message' && i.message.content)).toEqual(['Scope it', 'Hello there']);

    await chat(a.id, 'Branch question');
    const sent = llm.requests.at(-1)!.turns.map((t) => t.content);
    expect(sent[0]).toBe('Scope it');
    expect(sent.at(-1)).toBe('Branch question');
  });

  it('drafts a result without saving it, then finishing saves it', async () => {
    const [a] = await fork(rootId, ['A']);
    expect((await call('POST', `/nodes/${a.id}/result/draft`)).status).toBe(400); // no replies yet

    await chat(a.id, 'Question');
    const draft = await call<BranchResult>('POST', `/nodes/${a.id}/result/draft`);
    expect(draft.data.findings).toBe('drafted');
    expect((await call<NodeDetail>('GET', `/nodes/${a.id}`)).data.node.status).toBe('open');

    const finished = await call<DagNode>('PUT', `/nodes/${a.id}/result`, RESULT);
    expect(finished.data).toMatchObject({ status: 'finished', result: RESULT });
    expect((await call('POST', `/nodes/${a.id}/messages`, { content: 'more' })).status).toBe(409);
  });

  it('the root cannot be finished', async () => {
    expect((await call('PUT', `/nodes/${rootId}/result`, RESULT)).status).toBe(400);
  });

  it('merges finished branches; the merge node gets results, not transcripts', async () => {
    await chat(rootId, 'Scope it');
    const [a, b, c] = await fork(rootId, ['A', 'B', 'C']);
    await chat(a.id, 'secret transcript of A');
    await call('PUT', `/nodes/${a.id}/result`, { ...RESULT, findings: 'A result' });
    await call('PUT', `/nodes/${b.id}/result`, { ...RESULT, findings: 'B result' });

    expect((await call('POST', '/projects/default/merge', { parentIds: [a.id, c.id], title: 'M' })).status).toBe(409);
    expect((await call('POST', '/projects/default/merge', { parentIds: [a.id, a.id], title: 'M' })).status).toBe(400);

    const merged = await call<DagNode>('POST', '/projects/default/merge', { parentIds: [a.id, b.id], title: 'M' });
    expect(merged.status).toBe(201);
    expect(merged.data.parentIds).toEqual([a.id, b.id]);

    const detail = (await call<NodeDetail>('GET', `/nodes/${merged.data.id}`)).data;
    expect(detail.inherited.map((i) => (i.kind === 'result' ? `result:${i.nodeTitle}` : i.message.content))).toEqual([
      'Scope it',
      'Hello there',
      'result:A',
      'result:B',
    ]);

    await chat(merged.data.id, 'Synthesize');
    const prompt = llm.requests.at(-1)!.turns.map((t) => t.content).join('\n');
    expect(prompt).toContain('A result');
    expect(prompt).not.toContain('secret transcript of A');
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
