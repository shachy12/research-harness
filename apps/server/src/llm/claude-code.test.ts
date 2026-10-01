import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionPlan } from '../dag/session.ts';
import { ClaudeCodeProvider, parseSearchLinks } from './claude-code.ts';
import type { ReplyContext, ReplyEvent } from './provider.ts';

const FAKE_CLI = path.join(import.meta.dirname, 'fake-claude.mjs');

let dir: string;
let logFile: string;
let provider: ClaudeCodeProvider;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-cc-'));
  logFile = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = logFile;
  provider = new ClaudeCodeProvider({ command: process.execPath, prefixArgs: [FAKE_CLI], cwd: dir });
});

afterEach(() => provider.dispose());

const log = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv?: string[]; message?: string; prompt?: string });

const ctx = (message: string, session: SessionPlan, nodeId = 'n1'): ReplyContext => ({
  nodeId,
  message,
  session,
  request: { system: '', turns: [] },
});

const NEW: SessionPlan = { mode: 'new', sessionId: null, preamble: null, transcript: [] };

async function collect(events: AsyncIterable<ReplyEvent>): Promise<ReplyEvent[]> {
  const all: ReplyEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

const replyText = (events: ReplyEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');

describe('ClaudeCodeProvider', () => {
  it('streams a reply and reports the session id', async () => {
    const events = await collect(provider.streamReply(ctx('hello', NEW), new AbortController().signal));
    expect(events[0]).toEqual({ type: 'session', sessionId: 'new-session' });
    expect(events).toContainEqual({ type: 'thinking' });
    expect(replyText(events)).toBe('echo: hello');
  });

  it('keeps one process per node across messages', async () => {
    const signal = new AbortController().signal;
    await collect(provider.streamReply(ctx('first', NEW), signal));
    await collect(provider.streamReply(ctx('second', NEW), signal));
    const entries = log();
    expect(entries.filter((e) => e.argv)).toHaveLength(1); // started once
    expect(entries.filter((e) => e.message).map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('forks the source session and sends the preamble with the first message', async () => {
    const plan: SessionPlan = { mode: 'fork', sessionId: 'S0', preamble: '[branch note]', transcript: [] };
    const events = await collect(provider.streamReply(ctx('question', plan), new AbortController().signal));
    expect(events[0]).toEqual({ type: 'session', sessionId: 'fork-of-S0' });

    const [start, first] = log();
    expect(start.argv).toEqual(expect.arrayContaining(['--resume', 'S0', '--fork-session']));
    expect(start.argv).toEqual(expect.arrayContaining(['--tools', 'WebSearch,WebFetch']));
    expect(first.message).toBe('[branch note]\n\nquestion');
  });

  it('resumes an existing session and sends only the message', async () => {
    const plan: SessionPlan = { mode: 'resume', sessionId: 'S1', preamble: null, transcript: [] };
    await collect(provider.streamReply(ctx('again', plan), new AbortController().signal));
    const [start, first] = log();
    expect(start.argv).toEqual(expect.arrayContaining(['--resume', 'S1']));
    expect(start.argv).not.toContain('--fork-session');
    expect(first.message).toBe('again');
  });

  it('reports web searches as tool calls with their result links', async () => {
    const events = await collect(provider.streamReply(ctx('please search', NEW), new AbortController().signal));
    const calls = events.flatMap((e) => (e.type === 'tool' ? [e.call] : []));
    expect(calls.map((c) => c.status)).toEqual(['running', 'done']);
    expect(calls[1]).toMatchObject({ name: 'web_search', input: 'q', results: [{ title: 'Doc [1]', url: 'https://example.org/a' }] });
  });

  it('fails the reply if the process dies, and starts a fresh one next time', async () => {
    const signal = new AbortController().signal;
    await expect(collect(provider.streamReply(ctx('crash now', NEW), signal))).rejects.toThrow(/stopped unexpectedly/);
    const events = await collect(provider.streamReply(ctx('ok', NEW), signal));
    expect(replyText(events)).toBe('echo: ok');
    expect(log().filter((e) => e.argv)).toHaveLength(2);
  });

  it('drafts a result in a throwaway fork', async () => {
    const plan: SessionPlan = { mode: 'resume', sessionId: 'SA', preamble: null, transcript: [] };
    const result = await provider.draftResult(ctx('write the result', plan), new AbortController().signal);
    expect(result.findings).toBe('drafted by fake');

    const [run] = log();
    expect(run.argv).toEqual(expect.arrayContaining(['--resume', 'SA', '--fork-session', '--no-session-persistence', '--json-schema']));
    expect(run.prompt).toBe('write the result');
  });
});

describe('parseSearchLinks', () => {
  it('extracts the links list, even with brackets in titles', () => {
    const text = 'Links: [{"title":"A [x]","url":"https://a"},{"title":"B","url":"https://b"}]\n\nmore';
    expect(parseSearchLinks(text)).toEqual([
      { title: 'A [x]', url: 'https://a' },
      { title: 'B', url: 'https://b' },
    ]);
  });

  it('returns nothing when there is no list', () => {
    expect(parseSearchLinks('no links here')).toEqual([]);
  });
});
