import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionPlan } from '../dag/session.ts';
import { ClaudeCodeProvider, cliEnv, parseSearchLinks, toolArgs } from './claude-code.ts';
import type { ReplyContext, ReplyEvent } from './provider.ts';

const FAKE_CLI = path.join(import.meta.dirname, 'fake-claude.mjs');

let dir: string;
let logFile: string;
let provider: ClaudeCodeProvider;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-cc-'));
  logFile = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = logFile;
  provider = new ClaudeCodeProvider({ command: process.execPath, prefixArgs: [FAKE_CLI], model: 'claude-opus-5-5', effort: 'high' });
});

afterEach(() => provider.dispose());

const log = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv?: string[]; cwd?: string; message?: string; prompt?: string });

const ctx = (message: string, session: SessionPlan, nodeId = 'n1'): ReplyContext => ({
  nodeId,
  workDir: dir,
  message,
  session,
  request: { system: '', turns: [] },
  model: null,
  effort: null,
  edit: null,
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

  it("runs in the project's working folder; only web tools are pre-approved", async () => {
    await collect(provider.streamReply(ctx('hello', NEW), new AbortController().signal));
    const [start] = log();
    expect(path.resolve(start.cwd!)).toBe(path.resolve(dir));
    expect(start.argv).toEqual(expect.arrayContaining(['--tools', 'WebSearch,WebFetch,Read,Glob,Grep']));
    expect(start.argv).toEqual(expect.arrayContaining(['--allowedTools', 'WebSearch,WebFetch']));
  });

  it("with file editing, adds Edit/Write and allows them only inside the node's copy", async () => {
    const signal = new AbortController().signal;
    const edit = { dir: path.join(dir, '.harness', 'work', 'abcd1234') };
    await collect(provider.streamReply({ ...ctx('first', NEW), edit }, signal));
    await collect(provider.streamReply({ ...ctx('second', NEW), edit }, signal)); // same process
    const starts = log().filter((e) => e.argv).map((e) => e.argv!);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(expect.arrayContaining(['--tools', 'WebSearch,WebFetch,Read,Glob,Grep,Edit,Write']));
    expect(starts[0]).toEqual(expect.arrayContaining(['--allowedTools', 'WebSearch,WebFetch,Edit(.harness/work/abcd1234/**)']));
    expect(() => toolArgs(dir, { dir: path.dirname(dir) })).toThrow(/inside the project folder/);
  });

  it('reports file reads as tool calls', async () => {
    const events = await collect(provider.streamReply(ctx('see the attached paper', NEW), new AbortController().signal));
    const calls = events.flatMap((e) => (e.type === 'tool' ? [e.call] : []));
    expect(calls.at(-1)).toMatchObject({ name: 'read_file', input: 'C:\\p\\.harness\\uploads\\paper.pdf', status: 'done', results: [] });
  });

  it("passes the node's model and effort, and restarts the process (resuming) when they change", async () => {
    const signal = new AbortController().signal;
    const first = await collect(provider.streamReply({ ...ctx('first', NEW), model: 'claude-sonnet-5-5', effort: 'low' }, signal));
    expect(first).toContainEqual({ type: 'model', model: 'claude-sonnet-5-5' });
    // Same settings: the running process answers.
    await collect(provider.streamReply({ ...ctx('second', NEW), model: 'claude-sonnet-5-5', effort: 'low' }, signal));
    const resume: SessionPlan = { mode: 'resume', sessionId: 'new-session', preamble: null, transcript: [] };
    await collect(provider.streamReply({ ...ctx('third', resume), model: 'claude-opus-5-5', effort: 'max' }, signal));

    const starts = log().filter((e) => e.argv).map((e) => e.argv!);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'low']));
    expect(starts[1]).toEqual(expect.arrayContaining(['--resume', 'new-session', '--model', 'claude-opus-5-5', '--effort', 'max']));
    expect(log().filter((e) => e.message).map((e) => e.message)).toEqual(['first', 'second', 'third']);
  });

  it('uses the default model and effort for nodes without their own, and no effort for Haiku', async () => {
    provider = new ClaudeCodeProvider({ command: process.execPath, prefixArgs: [FAKE_CLI], model: 'claude-opus-5-5', effort: 'high' });
    const signal = new AbortController().signal;
    await collect(provider.streamReply(ctx('a', NEW, 'n1'), signal));
    await collect(provider.streamReply({ ...ctx('b', NEW, 'n2'), model: 'claude-haiku-4-5' }, signal));
    const [a, b] = log().filter((e) => e.argv).map((e) => e.argv!);
    expect(a).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'high']));
    expect(b).toEqual(expect.arrayContaining(['--model', 'claude-haiku-4-5']));
    expect(b).not.toContain('--effort');
  });

  // The prompt cache only works across branches if their requests start identically. Two things
  // broke that before (measured 2026-10-02): CLAUDE* variables leaking in from a parent Claude Code
  // session, and any difference in the flags. scripts/check-cache.ts checks the real CLI.
  describe('keeps forks cacheable', () => {
    it('never passes a parent Claude Code session\'s CLAUDE* variables to the CLI', async () => {
      const saved = { ...process.env };
      Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'medium' });
      try {
        await collect(provider.streamReply(ctx('hello', NEW), new AbortController().signal));
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
      const [start] = log() as { claudeEnv?: string[] }[];
      expect(start.claudeEnv).toEqual(['CLAUDE_CODE_TETHER_LIVE']);
    });

    it('starts sibling branches with the same flags and session, so their prompts share a prefix', async () => {
      const signal = new AbortController().signal;
      const fork = (title: string): SessionPlan => ({ mode: 'fork', sessionId: 'parent-session', preamble: `[Branch ${title}]`, transcript: [] });
      const settings = { model: 'claude-sonnet-5-5', effort: 'high' } as const;
      await collect(provider.streamReply({ ...ctx('question A', fork('A'), 'a'), ...settings }, signal));
      await collect(provider.streamReply({ ...ctx('question B', fork('B'), 'b'), ...settings }, signal));
      const [a, b] = log().filter((e) => e.argv).map((e) => e.argv!);
      expect(a).toEqual(b);
      expect(a).toEqual(expect.arrayContaining(['--resume', 'parent-session', '--fork-session']));
    });

    it('reports the reply\'s cache use', async () => {
      const events = await collect(provider.streamReply(ctx('hello', NEW), new AbortController().signal));
      expect(events).toContainEqual({ type: 'usage', usage: { input: 3, cacheRead: 100, cacheWrite: 20 } });
    });
  });

  it('runs the CLI without the variables a parent Claude Code session sets', () => {
    expect(cliEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_EFFORT: 'medium', CLAUDE_CONFIG_DIR: 'c', ANTHROPIC_API_KEY: 'k' }))
      .toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'c', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_TETHER_LIVE: 'false' });
  });

  it('turns off the CLI\'s Message Threads, which keep forks and resumes from reading the cache', () => {
    expect(cliEnv({ CLAUDE_CODE_TETHER_LIVE: 'true' }).CLAUDE_CODE_TETHER_LIVE).toBe('false');
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

  it('explains a reached usage limit, with its reset time, and starts fresh next time', async () => {
    const signal = new AbortController().signal;
    const events: ReplyEvent[] = [];
    const failed = (async () => {
      for await (const e of provider.streamReply(ctx('hit-limit please', NEW), signal)) events.push(e);
    })();
    await expect(failed).rejects.toMatchObject({
      kind: 'usage_limit',
      resetsAt: new Date(1790000000 * 1000).toISOString(),
      message: expect.stringContaining("You've hit your limit"),
    });
    expect(events).toContainEqual({
      type: 'limit',
      limit: { status: 'reached', resetsAt: new Date(1790000000 * 1000).toISOString(), limitType: 'five_hour', utilization: 1 },
    });
    await collect(provider.streamReply(ctx('ok', NEW), signal));
    expect(log().filter((e) => e.argv)).toHaveLength(2); // the failed process was not reused
  });

  it('passes on a warning when close to the limit, with how much is used', async () => {
    const events = await collect(provider.streamReply(ctx('warn me', NEW), new AbortController().signal));
    expect(events).toContainEqual({
      type: 'limit',
      limit: { status: 'warning', resetsAt: new Date(1790000000 * 1000).toISOString(), limitType: 'seven_day', utilization: 0.25 },
    });
    expect(replyText(events)).toBe('echo: warn me');
  });

  it('explains a usage limit when drafting a result', async () => {
    const plan: SessionPlan = { mode: 'resume', sessionId: 'SA', preamble: null, transcript: [] };
    await expect(provider.draftResult(ctx('hit-limit', plan), new AbortController().signal)).rejects.toMatchObject({ kind: 'usage_limit' });
  });

  it('suggests a title with a small model, without tools or a saved session', async () => {
    const title = await provider.suggestTitle({ prompt: 'Compare A and B', reply: 'A is…', workDir: dir }, new AbortController().signal);
    expect(title).toBe('"Fake Title."'); // cleaned up by the caller
    const [run] = log();
    expect(run.argv).toEqual(expect.arrayContaining(['--model', 'haiku', '--no-session-persistence', '--tools', '']));
    expect(run.prompt).toContain('Compare A and B');
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
