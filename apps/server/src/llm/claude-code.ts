import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { type BranchResult, type Effort, type ModelOption, type ToolCall, branchResultSchema } from '@harness/shared';
import { z } from 'zod/v4';
import { SYSTEM_PROMPT } from '../dag/prompt.ts';
import { type SessionPlan, firstMessage } from '../dag/session.ts';
import { classifyError, toIsoTime } from './errors.ts';
import type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent, TokenUsage } from './provider.ts';
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
  /**
   * Model and effort for nodes without their own setting. Always passed: left to the account, the
   * model changes on its own (Opus to Sonnet after heavy use, seen 2026-10-02) and the CLI doesn't
   * report its default effort.
   */
  model: string;
  effort: Effort;
  /** More model ids to offer (HARNESS_MODELS: e.g. Bedrock ids); they take every effort level. */
  extraModels?: string[];
  /** Stop a node's process after this long without messages. */
  idleMs?: number;
}

// Available tools. Only web search/fetch are pre-approved; Read/Glob/Grep work inside the working
// folder by Claude Code's default permissions, and a read outside it is refused (no one is there to
// approve it in -p mode). So the model can read the project's files and uploads, and nothing else.
const TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep';
const PRE_APPROVED = 'WebSearch,WebFetch';
// With an editable copy (always, see worktrees.ts), Edit and Write are added and allowed only inside it
// (`Edit(<path>/**)`; the rule covers Write too, verified with CLI 2.1.287). Edits anywhere else are
// refused like reads outside the folder. The rules are given twice, relative to the project folder and
// as absolute paths (`//c/Users/…`): after the model `cd`s into its copy (a git worktree), the CLI
// sometimes moves its own working folder there (seen 2026-10-08, CLI 2.1.287), and relative rules then
// point inside the copy, so writes were refused. A `Read` rule for the project folder keeps the
// uploads and the project's files readable in that case (by default only the working folder is).
// Bash comes with them and is allowed for every command (the user's call, 2026-10-03): unlike Edit,
// a shell command can't be limited to the copy, so editNote asks the model to run commands there.
// On Windows the CLI runs it in Git Bash.
const EDIT_TOOLS = 'Edit,Write,Bash';
/** How much of a shell command's output a tool call keeps (the end, where errors usually are). */
const SHELL_OUTPUT_CHARS = 4000;
/** How much of a node's answer an ask_node call keeps for the chat. */
const ANSWER_CHARS = 20_000;

// The harness's own MCP server (tools/harness.ts): fork_branches and ask_node, both pre-approved.
// Tool definitions are part of the cached prompt prefix, so every node gets the same ones; the node
// id is only in the server's URL, which the model never sees. `alwaysLoad` keeps the tools in the
// prompt instead of behind the CLI's tool search.
const HARNESS_MCP = 'harness';
const HARNESS_ALLOWED = `mcp__${HARNESS_MCP}`;
/** ask_node waits for another node's answer, which can take several minutes on a large model. */
const HARNESS_TOOL_TIMEOUT_MS = 30 * 60_000;

// The CLI's schema validator rejects the `$schema` dialect line zod adds, so leave it out.
const { $schema: _dialect, ...RESULT_JSON_SCHEMA } = z.toJSONSchema(branchResultSchema);
// The CLI has no command that lists models; it accepts these full ids with --model. Haiku takes no effort.
const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', efforts: ALL_EFFORTS },
  { id: 'claude-sonnet-5-5', efforts: ALL_EFFORTS },
  { id: 'claude-fable-5-1', efforts: ALL_EFFORTS },
  { id: 'claude-haiku-4-5', efforts: [] },
];

const TOOL_NAMES: Record<string, string> = {
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  Read: 'read_file',
  Glob: 'find_files',
  Grep: 'search_files',
  Edit: 'edit_file',
  Write: 'write_file',
  Bash: 'shell',
  [`mcp__${HARNESS_MCP}__fork_branches`]: 'fork_branches',
  [`mcp__${HARNESS_MCP}__ask_node`]: 'ask_node',
};

/**
 * The environment for the CLI: ours, unchanged, so whatever the user set for the CLI (Bedrock,
 * proxy, config dir, …) reaches it.
 *
 * With HARNESS_ISOLATE_CLAUDE_ENV=1 (a development switch, set by `check:cache`; use it when the
 * server is started from inside a Claude Code session) the variables such a session sets for its
 * own child processes (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, …) are removed. They
 * change how the CLI behaves; with them, no run reused the prompt cache of another (measured
 * 2026-10-02). CLAUDE_CONFIG_DIR, a login token and the Bedrock/Vertex/Foundry switches are kept.
 *
 * CLAUDE_CODE_TETHER_LIVE=false turns off the CLI's "tether" (server-side Message Threads, beta
 * message-threads-2026-08-12), which Anthropic enables remotely per account and model. With it,
 * each CLI process gets its own thread and the cache doesn't carry over: on Sonnet 5.5 a fork or
 * resume read only the system prompt from the cache (measured 2026-10-02, CLI 2.1.287; Opus 5.5
 * wasn't enrolled then). The variable is internal and undocumented; `check:cache` notices if it
 * stops working.
 */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.HARNESS_ISOLATE_CLAUDE_ENV) return { ...env, CLAUDE_CODE_TETHER_LIVE: 'false' };
  const keep = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']);
  // The second group chooses where the CLI sends requests (Bedrock, Vertex, Foundry).
  const kept = Object.entries(env).filter(
    ([key]) => !/^CLAUDE/i.test(key) || keep.has(key.toUpperCase()) || /^CLAUDE_CODE_(USE_|SKIP_).*(BEDROCK|VERTEX|FOUNDRY|MANTLE)/i.test(key),
  );
  return { ...Object.fromEntries(kept), CLAUDE_CODE_TETHER_LIVE: 'false' };
}

/**
 * Locate the Claude Code CLI: HARNESS_CLAUDE_PATH, the npm global install on Windows, the usual
 * install places on macOS and Linux, else `claude` on PATH.
 *
 * The macOS/Linux places matter for the desktop app: started from the Dock, Finder or a desktop
 * launcher, it doesn't get the PATH your shell sets up (e.g. ~/.local/bin, Homebrew), so a bare
 * `claude` would not be found.
 */
export function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HARNESS_CLAUDE_PATH) return env.HARNESS_CLAUDE_PATH;
  if (platform === 'win32') {
    if (env.APPDATA) {
      const exe = path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(exe)) return exe;
    }
    return 'claude';
  }
  const home = env.HOME;
  const candidates = [
    home && path.join(home, '.local', 'bin', 'claude'), // the native installer (claude.ai/install.sh)
    home && path.join(home, '.claude', 'local', 'claude'), // older local installs (`claude migrate-installer`)
    env.NPM_CONFIG_PREFIX && path.join(env.NPM_CONFIG_PREFIX, 'bin', 'claude'),
    home && path.join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', // Homebrew on Apple silicon
    '/usr/local/bin/claude', // Homebrew on Intel Macs, npm's default prefix
    '/usr/bin/claude',
  ];
  return candidates.find((file): file is string => !!file && existsSync(file)) ?? 'claude';
}

/** A failure to start the CLI, with a message the user can act on when it isn't installed. */
export function spawnError(err: Error, command: string): Error {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return err;
  return new Error(`Claude Code was not found (tried "${command}"). Install it (https://claude.com/claude-code), or set HARNESS_CLAUDE_PATH to the full path of the claude executable.`);
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly label: string;
  private readonly options: ClaudeCodeOptions;
  readonly kind = 'claude-code';
  readonly canEdit = true;
  private readonly live = new Map<string, LiveProcess>();

  constructor(options: ClaudeCodeOptions) {
    this.options = options;
    this.label = 'Claude Code';
  }

  async models(): Promise<ModelCatalog> {
    // The default model (HARNESS_MODEL, maybe an alias such as "opus" or a Bedrock id) and
    // HARNESS_MODELS are offered as they are, next to the full ids.
    const extra = [this.options.model, ...(this.options.extraModels ?? [])]
      .filter((id, i, ids) => ids.indexOf(id) === i && !MODELS.some((m) => m.id === id));
    return {
      models: [...extra.map((id) => ({ id, efforts: ALL_EFFORTS })), ...MODELS],
      defaultModel: this.options.model,
      defaultEffort: this.options.effort,
      forkKeepsCache: true,
    };
  }

  async *streamReply(ctx: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const flags = [...this.modelArgs(ctx), ...toolArgs(ctx.workDir, ctx.edit, ctx.mcpUrl)];
    let proc = this.live.get(ctx.nodeId);
    // The model, effort and tools are fixed when the process starts: after a change, restart it (the
    // session resumes; the new model re-reads the history without the cache either way).
    if (proc && proc.flags !== flags.join(' ')) {
      this.release(ctx.nodeId);
      proc = undefined;
    }
    let text = ctx.message;
    if (!proc) {
      proc = this.startProcess(ctx.nodeId, ctx.session, ctx.workDir, flags);
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
      ...this.modelArgs(ctx),
    ];
    const prompt = plan.mode === 'resume' ? ctx.message : firstMessage(plan, ctx.message);
    const parsed = await runJson(this.options, ctx.workDir, args, prompt, signal);
    if (parsed.is_error) throw classifyError(new Error(parsed.result || 'Claude Code could not draft the result.'));
    const value = parsed.structured_output ?? tryJson(parsed.result);
    const result = branchResultSchema.safeParse(value);
    if (!result.success) throw new Error('The model could not draft a result for this branch. Write it by hand instead.');
    return result.data;
  }

  async askNode(ctx: ReplyContext, signal: AbortSignal): Promise<{ answer: string; usage: TokenUsage | null }> {
    // Like a result draft: a throwaway fork of the node's session, so its conversation stays as it
    // was. The same flags and tool list as the node's own replies (the edit tools listed but not
    // allowed), so the fork reads the node's cached prompt.
    const plan = ctx.session;
    const args = [
      '-p',
      ...(plan.mode === 'resume' ? ['--resume', plan.sessionId!, '--fork-session'] : sessionArgs(plan)),
      '--no-session-persistence',
      '--output-format', 'json',
      ...this.commonArgs(),
      ...this.modelArgs(ctx),
      ...answerToolArgs(ctx.mcpUrl),
    ];
    const prompt = plan.mode === 'resume' ? ctx.message : firstMessage(plan, ctx.message);
    const parsed = await runJson(this.options, ctx.workDir, args, prompt, signal);
    if (parsed.is_error) throw classifyError(new Error(parsed.result || 'Claude Code could not answer the question.'));
    return { answer: parsed.result ?? '', usage: parsed.usage ? toUsage(parsed.usage) : null };
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
    ];
  }

  /** --model / --effort for this node: its own setting, else the defaults. No effort for Haiku. */
  private modelArgs(ctx: Pick<ReplyContext, 'model' | 'effort'>): string[] {
    const model = ctx.model ?? this.options.model;
    const takesEffort = MODELS.find((m) => m.id === model)?.efforts.length !== 0;
    return ['--model', model, ...(takesEffort ? ['--effort', ctx.effort ?? this.options.effort] : [])];
  }

  private startProcess(nodeId: string, plan: SessionPlan, workDir: string, flags: string[]): LiveProcess {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...sessionArgs(plan),
      ...this.commonArgs(),
      ...flags,
    ];
    const proc = new LiveProcess(this.options, workDir, args, flags.join(' '), () => {
      if (this.live.get(nodeId) === proc) this.live.delete(nodeId);
    });
    this.live.set(nodeId, proc);
    return proc;
  }
}

/**
 * --tools / --allowedTools: read-only, or with Edit/Write allowed only inside the node's copy; plus
 * the harness MCP server when there is one.
 */
export function toolArgs(workDir: string, edit: ReplyContext['edit'], mcpUrl: string | null = null): string[] {
  const harness = mcpUrl ? `,${HARNESS_ALLOWED}` : '';
  if (!edit) return ['--tools', TOOLS, '--allowedTools', PRE_APPROVED + harness, ...mcpArgs(mcpUrl)];
  const rel = path.relative(workDir, edit.dir).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`The editable copy must be inside the project folder: ${edit.dir}`);
  const edits = `Edit(${rel}/**),Edit(${absoluteRule(edit.dir)}/**),Read(${absoluteRule(workDir)}/**)`;
  return ['--tools', `${TOOLS},${EDIT_TOOLS}`, '--allowedTools', `${PRE_APPROVED},${edits},Bash${harness}`, ...mcpArgs(mcpUrl)];
}

/**
 * A folder as an absolute path in Claude Code's permission rules: `//` and the path in POSIX form
 * (`C:\Users\x` → `//c/Users/x`, `/home/x` → `//home/x`). The `//C:/…` form doesn't match on Windows
 * (verified with CLI 2.1.287).
 */
export function absoluteRule(dir: string): string {
  const posix = path.resolve(dir).split(path.sep).join('/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
  return `/${posix}`;
}

/**
 * Tools for answering a question from a finished or forked node (ask_node): the same list as an
 * editing node's (so the cached prompt matches), with nothing beyond reading and the web allowed.
 */
export function answerToolArgs(mcpUrl: string | null): string[] {
  return ['--tools', `${TOOLS},${EDIT_TOOLS}`, '--allowedTools', PRE_APPROVED + (mcpUrl ? `,${HARNESS_ALLOWED}` : ''), ...mcpArgs(mcpUrl)];
}

function mcpArgs(url: string | null): string[] {
  if (!url) return [];
  const config = { mcpServers: { [HARNESS_MCP]: { type: 'http', url, timeout: HARNESS_TOOL_TIMEOUT_MS, alwaysLoad: true } } };
  return ['--mcp-config', JSON.stringify(config)];
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
  /** The --model / --effort flags it was started with. */
  readonly flags: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly idleMs: number;
  private turn: Channel<ReplyEvent> | null = null;
  private turnState: TurnState = newTurnState();
  private idleTimer: NodeJS.Timeout | null = null;
  private stderr = '';
  private exited = false;

  constructor(options: ClaudeCodeOptions, cwd: string, args: string[], flags: string, onExit: () => void) {
    this.flags = flags;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.child = spawn(options.command, [...(options.prefixArgs ?? []), ...args], {
      cwd,
      env: cliEnv(),
      windowsHide: true,
    });
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
    this.child.on('error', (err) => this.finishTurn(spawnError(err, options.command)));
    // Writing to a CLI that already exited fails with EPIPE (on Linux and macOS); unhandled, that
    // would crash the server. The 'close' handler reports the failure instead.
    this.child.stdin.on('error', () => {});
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
      if (result.usage) turn.push({ type: 'usage', usage: toUsage(result.usage) });
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
  | { type: 'tool_use'; id: string; name: string; input: ToolInput }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: string | { type: string; text?: string }[] }
  | { type: string };

/** The tool inputs we show (built-in tools, and the harness MCP tools). */
type ToolInput = {
  query?: string; url?: string; file_path?: string; pattern?: string; command?: string;
  nodeId?: string; question?: string; branches?: { title?: string; prompt?: string }[];
};

/** What a tool call shows as its input. */
function shownInput(name: string, input: ToolInput): string {
  if (name === 'ask_node') return input.question ?? '';
  if (name === 'fork_branches') {
    return (input.branches ?? []).map((b) => b.title || b.prompt?.split('\n')[0] || '').join(' · ');
  }
  return input.query ?? input.url ?? input.file_path ?? input.pattern ?? input.command ?? '';
}

type CliUsage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

const toUsage = (u: CliUsage): TokenUsage => ({
  input: u.input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
});

type ResultEvent = {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: CliUsage;
};

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
  | { type: 'system'; subtype: string; session_id?: string; model?: string }
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
  if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
    const init = event as { session_id?: string; model?: string };
    return [
      ...(init.session_id ? [{ type: 'session' as const, sessionId: init.session_id }] : []),
      ...(init.model ? [{ type: 'model' as const, model: init.model }] : []),
    ];
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
        const name = TOOL_NAMES[block.name];
        const call: ToolCall = { id: block.id, name, input: shownInput(name, block.input), status: 'running', results: [] };
        // The title is filled in by the run manager, which knows the graph.
        if (name === 'ask_node' && block.input.nodeId) call.node = { id: block.input.nodeId, title: '' };
        state.calls.set(call.id, call);
        out.push({ type: 'tool', call: { ...call } });
      } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
        const call = state.calls.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === 'string' ? block.content : block.content.map((c) => c.text ?? '').join('\n');
        if (call.name === 'shell') call.output = text.length > SHELL_OUTPUT_CHARS ? `…${text.slice(-SHELL_OUTPUT_CHARS)}` : text;
        if (call.name === 'ask_node') call.output = text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS)}…` : text;
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

type OneShotResult = { is_error?: boolean; result?: string; structured_output?: unknown; usage?: CliUsage };

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
      env: cliEnv(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => reject(spawnError(err, options.command)));
    child.stdin.on('error', () => {}); // EPIPE if the CLI exits early; 'close' reports it
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
