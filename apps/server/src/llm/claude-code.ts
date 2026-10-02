import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { type BranchResult, type ToolCall, branchResultSchema } from '@harness/shared';
import { z } from 'zod/v4';
import { SYSTEM_PROMPT } from '../dag/prompt.ts';
import { type SessionPlan, firstMessage } from '../dag/session.ts';
import { classifyError, toIsoTime } from './errors.ts';
import type { LLMProvider, ReplyContext, ReplyEvent } from './provider.ts';
import { TITLE_SYSTEM_PROMPT, titleRequest } from './title.ts';

/**
 * Runs the Claude Code CLI in the background with the user's own Claude login.
 *
 * Each node you chat in gets one long-lived `claude -p` process in stream-json mode: messages are
 * written to its stdin as JSON lines, replies stream back on stdout, and the process stays alive
 * between messages (stopped after a while idle, or when the node is forked or finished).
 * A node's first message starts the process fresh, resumed, or forked from the parent's session.
 */
export interface ClaudeCodeOptions {
  /** The claude executable. */
  command: string;
  /** Arguments placed before the CLI flags (tests run a fake CLI script through node). */
  prefixArgs?: string[];
  model?: string;
  /** Stop a node's process after this long without messages. */
  idleMs?: number;
}

// Available tools. Only web search/fetch are pre-approved; Read/Glob/Grep work inside the working
// folder by Claude Code's default permissions, and a read outside it is refused (no one is there to
// approve it in -p mode). So the model can read the project's files and uploads, and nothing else.
const TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep';
const PRE_APPROVED = 'WebSearch,WebFetch';

// The CLI's schema validator rejects the `$schema` dialect line zod adds, so leave it out.
const { $schema: _dialect, ...RESULT_JSON_SCHEMA } = z.toJSONSchema(branchResultSchema);
const TOOL_NAMES: Record<string, string> = {
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  Read: 'read_file',
  Glob: 'find_files',
  Grep: 'search_files',
};

/** Locate the Claude Code CLI: HARNESS_CLAUDE_PATH, the npm global install on Windows, or `claude` on PATH. */
export function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HARNESS_CLAUDE_PATH) return env.HARNESS_CLAUDE_PATH;
  if (process.platform === 'win32' && env.APPDATA) {
    const exe = path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude';
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly label: string;
  private readonly options: ClaudeCodeOptions;
  private readonly live = new Map<string, LiveProcess>();

  constructor(options: ClaudeCodeOptions) {
    this.options = options;
    this.label = `claude-code:${options.model ?? 'account default'}`;
  }

  async *streamReply(ctx: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    let proc = this.live.get(ctx.nodeId);
    let text = ctx.message;
    if (!proc) {
      proc = this.startProcess(ctx.nodeId, ctx.session, ctx.workDir);
      // A resumed session already holds the context; otherwise send the preamble/transcript first.
      if (ctx.session.mode !== 'resume') text = firstMessage(ctx.session, ctx.message);
    }

    // Stop ends the process; the session is saved up to that point and the next message resumes it.
    const onAbort = () => this.release(ctx.nodeId);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      yield* proc.send(text);
    } catch (err) {
      // Start over after a failure: a retry plans its session afresh.
      this.release(ctx.nodeId);
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async draftResult(ctx: ReplyContext, signal: AbortSignal): Promise<BranchResult> {
    // A throwaway fork of the node's session, not saved, so drafting leaves the conversation unchanged.
    const plan = ctx.session;
    const args = [
      '-p',
      ...(plan.mode === 'resume' ? ['--resume', plan.sessionId!, '--fork-session'] : sessionArgs(plan)),
      '--no-session-persistence',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(RESULT_JSON_SCHEMA),
      '--tools', '',
      ...this.commonArgs(),
    ];
    const prompt = plan.mode === 'resume' ? ctx.message : firstMessage(plan, ctx.message);
    const parsed = await runJson(this.options, ctx.workDir, args, prompt, signal);
    if (parsed.is_error) throw classifyError(new Error(parsed.result || 'Claude Code could not draft the result.'));
    const value = parsed.structured_output ?? tryJson(parsed.result);
    const result = branchResultSchema.safeParse(value);
    if (!result.success) throw new Error('The model could not draft a result for this branch. Write it by hand instead.');
    return result.data;
  }

  async suggestTitle({ prompt, reply, workDir }: { prompt: string; reply: string; workDir: string }, signal: AbortSignal): Promise<string> {
    // A small model, no tools, nothing saved: a fraction of a normal reply.
    const args = [
      '-p',
      '--model', 'haiku',
      '--no-session-persistence',
      '--output-format', 'json',
      '--tools', '',
      '--system-prompt', TITLE_SYSTEM_PROMPT,
      '--setting-sources', '',
      '--strict-mcp-config',
    ];
    const parsed = await runJson(this.options, workDir, args, titleRequest(prompt, reply), signal);
    if (parsed.is_error) throw classifyError(new Error(parsed.result || 'Claude Code could not suggest a title.'));
    return parsed.result ?? '';
  }

  release(nodeId: string): void {
    this.live.get(nodeId)?.kill();
    this.live.delete(nodeId);
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) this.release(id);
  }

  private commonArgs(): string[] {
    return [
      '--system-prompt', SYSTEM_PROMPT,
      // Ignore the user's own Claude Code settings, memory files and MCP servers.
      '--setting-sources', '',
      '--strict-mcp-config',
      ...(this.options.model ? ['--model', this.options.model] : []),
    ];
  }

  private startProcess(nodeId: string, plan: SessionPlan, workDir: string): LiveProcess {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...sessionArgs(plan),
      '--tools', TOOLS,
      '--allowedTools', PRE_APPROVED,
      ...this.commonArgs(),
    ];
    const proc = new LiveProcess(this.options, workDir, args, () => {
      if (this.live.get(nodeId) === proc) this.live.delete(nodeId);
    });
    this.live.set(nodeId, proc);
    return proc;
  }
}

function sessionArgs(plan: SessionPlan): string[] {
  if (plan.mode === 'resume') return ['--resume', plan.sessionId!];
  if (plan.mode === 'fork') return ['--resume', plan.sessionId!, '--fork-session'];
  return [];
}

function tryJson(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** One long-lived CLI process. Turns run one at a time; each ends with a `result` event. */
class LiveProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly idleMs: number;
  private turn: Channel<ReplyEvent> | null = null;
  private turnState: TurnState = newTurnState();
  private idleTimer: NodeJS.Timeout | null = null;
  private stderr = '';
  private exited = false;

  constructor(options: ClaudeCodeOptions, cwd: string, args: string[], onExit: () => void) {
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.child = spawn(options.command, [...(options.prefixArgs ?? []), ...args], {
      cwd,
      windowsHide: true,
    });
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
    this.child.on('error', (err) => this.finishTurn(err));
    this.child.on('close', (code) => {
      this.exited = true;
      this.clearIdle();
      onExit();
      const detail = this.stderr.trim().split('\n').at(-1);
      const error = classifyError(new Error(detail || 'no details'), this.turnState.resetsAt);
      this.finishTurn(error.kind === 'other'
        ? new Error(`Claude Code stopped unexpectedly (exit code ${code})${detail ? `: ${detail}` : ''}`)
        : error);
    });
  }

  send(text: string): AsyncIterable<ReplyEvent> {
    if (this.exited) throw new Error('Claude Code is not running');
    if (this.turn) throw new Error('A reply is already being generated');
    this.clearIdle();
    this.turn = new Channel<ReplyEvent>();
    this.turnState = newTurnState();
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    return this.turn;
  }

  kill(): void {
    this.clearIdle();
    if (!this.exited) this.child.kill();
  }

  private handleLine(line: string): void {
    let event: CliEvent;
    try {
      event = JSON.parse(line) as CliEvent;
    } catch {
      return; // not JSON (shouldn't happen in stream-json mode)
    }
    const turn = this.turn;
    if (!turn) return;

    if (event.type === 'result') {
      const result = event as ResultEvent;
      const failed = result.is_error || result.subtype !== 'success';
      // A usage limit, a missing login etc. arrive as a failed result (and as an `error` on the
      // assistant message); classifyError turns them into a message the user can act on.
      const text = result.result || this.turnState.apiError || `Claude Code error: ${result.subtype}`;
      this.finishTurn(failed ? classifyError(new Error(text), this.turnState.resetsAt) : undefined);
      return;
    }
    for (const out of mapEvent(event, this.turnState)) turn.push(out);
  }

  private finishTurn(error?: unknown): void {
    const turn = this.turn;
    this.turn = null;
    turn?.close(error);
    if (!this.exited && !error) this.idleTimer = setTimeout(() => this.kill(), this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

// ---- Claude Code stream-json events (only the fields we use) ----

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: { query?: string; url?: string; file_path?: string; pattern?: string } }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: string | { type: string; text?: string }[] }
  | { type: string };

type ResultEvent = { type: 'result'; subtype: string; is_error?: boolean; result?: string; session_id?: string };

/** Sent when the account's usage limit changes: fine, close to it, or reached. */
type RateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number | string | null;
    rateLimitType?: string | null;
    /** Share of the limit used, 0–1 (sent with warnings). */
    utilization?: number | null;
  };
};

type CliEvent =
  | { type: 'system'; subtype: string; session_id?: string }
  | { type: 'stream_event'; event: { type: string; content_block?: { type: string }; delta?: { type: string; text?: string } } }
  | { type: 'assistant' | 'user'; message: { content: ContentBlock[] | string }; error?: string }
  | ResultEvent
  | RateLimitEvent
  | { type: string };

export interface TurnState {
  wroteText: boolean;
  calls: Map<string, ToolCall>;
  /** When the usage limit resets, from a rate-limit event this turn. */
  resetsAt: string | null;
  /** The error the CLI attached to an assistant message (e.g. "rate_limit"), with its text. */
  apiError: string | null;
}

export const newTurnState = (): TurnState => ({ wroteText: false, calls: new Map(), resetsAt: null, apiError: null });

/** Translate one CLI event into our reply events. Exported for tests. */
export function mapEvent(event: CliEvent, state: TurnState): ReplyEvent[] {
  if (event.type === 'system' && 'subtype' in event && event.subtype === 'init' && 'session_id' in event && event.session_id) {
    return [{ type: 'session', sessionId: event.session_id }];
  }

  if (event.type === 'rate_limit_event' && 'rate_limit_info' in event && event.rate_limit_info) {
    const info = event.rate_limit_info;
    const resetsAt = toIsoTime(info.resetsAt);
    const limitType = info.rateLimitType ?? null;
    const utilization = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null;
    if (info.status === 'rejected') {
      state.resetsAt = resetsAt;
      return [{ type: 'limit', limit: { status: 'reached', resetsAt, limitType, utilization: utilization ?? 1 } }];
    }
    if (info.status === 'allowed_warning') {
      return [{ type: 'limit', limit: { status: 'warning', resetsAt, limitType, utilization } }];
    }
    return [{ type: 'limit', limit: null }];
  }

  if (event.type === 'stream_event' && 'event' in event) {
    const e = event.event;
    if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') return [{ type: 'thinking' }];
    // Separate text written after a search from the text before it.
    if (e.type === 'content_block_start' && e.content_block?.type === 'text' && state.wroteText) {
      return [{ type: 'text', text: '\n\n' }];
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      state.wroteText = true;
      return [{ type: 'text', text: e.delta.text }];
    }
    return [];
  }

  if ((event.type === 'assistant' || event.type === 'user') && 'message' in event && Array.isArray(event.message.content)) {
    if ('error' in event && event.error) {
      // The CLI writes the error as the message's text, e.g. "You've hit your limit · resets 5pm".
      const text = event.message.content.flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : [])).join(' ');
      state.apiError = text || event.error;
    }
    const out: ReplyEvent[] = [];
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && 'name' in block && TOOL_NAMES[block.name]) {
        const call: ToolCall = {
          id: block.id,
          name: TOOL_NAMES[block.name],
          input: block.input.query ?? block.input.url ?? block.input.file_path ?? block.input.pattern ?? '',
          status: 'running',
          results: [],
        };
        state.calls.set(call.id, call);
        out.push({ type: 'tool', call: { ...call } });
      } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
        const call = state.calls.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === 'string' ? block.content : block.content.map((c) => c.text ?? '').join('\n');
        if (block.is_error) {
          call.status = 'error';
          call.error = text.slice(0, 200);
        } else {
          call.status = 'done';
          call.results =
            call.name === 'web_search' ? parseSearchLinks(text)
            : call.name === 'web_fetch' ? [{ title: call.input, url: call.input }]
            : []; // local file reads/searches: nothing to link to
        }
        out.push({ type: 'tool', call: { ...call } });
      }
    }
    return out;
  }

  return [];
}

/** WebSearch results contain `Links: [{"title":…,"url":…}, …]`; pull that list out. */
export function parseSearchLinks(text: string): { title: string; url: string }[] {
  const start = text.indexOf('Links: [');
  if (start === -1) return [];
  const from = start + 'Links: '.length;
  for (let end = text.indexOf(']', from); end !== -1; end = text.indexOf(']', end + 1)) {
    try {
      const list = JSON.parse(text.slice(from, end + 1)) as { title?: string; url?: string }[];
      if (Array.isArray(list)) {
        return list.filter((l) => l?.url).map((l) => ({ title: String(l.title ?? l.url), url: String(l.url) }));
      }
    } catch {
      // not the end of the list yet; try the next ']'
    }
  }
  return [];
}

type OneShotResult = { is_error?: boolean; result?: string; structured_output?: unknown };

/** Run the CLI once in `--output-format json` mode and parse its answer. */
async function runJson(options: ClaudeCodeOptions, cwd: string, args: string[], prompt: string, signal: AbortSignal): Promise<OneShotResult> {
  const output = await runOnce(options, cwd, args, prompt, signal);
  try {
    return JSON.parse(output) as OneShotResult;
  } catch {
    throw new Error(`Claude Code returned something unexpected: ${output.slice(0, 200)}`);
  }
}

/** Run the CLI once with the prompt on stdin and return its stdout. */
function runOnce(options: ClaudeCodeOptions, cwd: string, args: string[], prompt: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...(options.prefixArgs ?? []), ...args], {
      cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      // A failed run may still print its JSON answer (is_error: true) on stdout; the caller reads it.
      if (stdout.trim().startsWith('{')) resolve(stdout);
      else {
        const detail = stderr.trim().split('\n').at(-1) ?? '';
        const error = classifyError(new Error(detail || 'no details'));
        reject(error.kind === 'other' ? new Error(`Claude Code failed (exit code ${code}): ${detail}`) : error);
      }
    });
    child.stdin.end(prompt);
  });
}

/** A simple async queue: the process pushes events, the reply stream reads them. */
class Channel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    this.buffer.push(item);
    this.notify();
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error ?? null;
    this.notify();
  }

  private notify(): void {
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.closed) {
        if (this.error) throw this.error;
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }
}
