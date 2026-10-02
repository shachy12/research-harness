import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Attachment, BranchResult, ChatStreamEvent, DagNode, GraphResponse, NodeDetail, Project, ProjectSummary } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { ChatRequest } from './dag/prompt.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import type { LLMProvider, ReplyContext, ReplyEvent } from './llm/index.ts';
import { Workspaces } from './workspace.ts';

/**
 * Records the requests it receives and replies with fixed text.
 * A message containing "slow" waits until the test calls `release()`.
 */
class FakeProvider implements LLMProvider {
  readonly label = 'fake';
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
    const failure = this.failNext;
    this.failNext = null;
    if (failure) throw failure;
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

  it("uploads files into the project's .harness/uploads and attaches them to a message", async () => {
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
    expect(existsSync(path.join(ctx.workDir, '.harness', '.gitignore'))).toBe(true);
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
    expect(test).toMatchObject({ name: 'Testing', folder: null });

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

  it('creates a project in a folder the user chose, and refuses unsuitable folders', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'harness-thesis-'));
    const { status, data } = await call<Project>('POST', '/projects', { name: 'Thesis', folder });
    expect(status).toBe(201);
    expect(path.resolve(data.folder!)).toBe(path.resolve(realpathSync(folder)));
    expect(existsSync(path.join(folder, '.harness', '.gitignore'))).toBe(true);

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
});
