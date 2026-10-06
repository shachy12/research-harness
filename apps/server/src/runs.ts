import {
  type Attachment,
  type ChatStreamEvent,
  type DagNode,
  type ForkProposal,
  type MergedResult,
  type MergeState,
  type Message,
  type RunStatus,
  type ToolCall,
  type UsageLimit,
  toolActivity,
} from '@harness/shared';
import { DRAFT_RESULT_INSTRUCTION, buildChatRequest, editNote, withAttachments } from './dag/prompt.ts';
import { type SessionPlan, planSession } from './dag/session.ts';
import type { Repository } from './db/repository.ts';
import { type ProviderError, classifyError } from './llm/errors.ts';
import type { LLMProvider, ReplyContext } from './llm/index.ts';
import { cleanTitle } from './llm/title.ts';
import { conflict, notFound } from './routes/errors.ts';
import type { Workspaces } from './workspace.ts';
import type { Worktrees } from './worktrees.ts';

type Listener = (event: ChatStreamEvent) => void;

interface Run {
  nodeId: string;
  startedAt: string;
  /** What the model is doing right now, for the "Working" indicators. */
  activity: string;
  text: string;
  toolCalls: Map<string, ToolCall>;
  thinking: boolean;
  /** The provider's session, saved once the reply has produced something (see execute). */
  sessionId: string | null;
  /** The model that answered, as the provider reported it. */
  model: string | null;
  /** Branches the model proposed (fork_branches); saved with the reply. */
  proposal: ForkProposal | null;
  /** ask_node questions this reply may still ask without the user's approval. */
  asksLeft: number;
  /** Questions waiting for the user's approval (see allowAsk). */
  waiting: WaitingAsks | null;
  listeners: Set<Listener>;
  abort: AbortController;
}

/** A merge node drafting the results of the nodes it merges, before its first message. */
interface MergeJob {
  startedAt: string;
  activity: string;
  abort: AbortController;
}

/** What happened to a question that needed the user's approval ('away': no answer in time). */
type AskDecision = 'allowed' | 'denied' | 'away';

interface WaitingAsks {
  asks: { nodeTitle: string; from: string | null; question: string; decide: (d: AskDecision) => void }[];
  expiresAt: string;
  timer: NodeJS.Timeout;
}

/** Whether an ask_node question may run, and if so how many free ones are left in the reply. */
export type AskOutcome = { decision: 'allowed'; freeLeft: number } | { decision: 'denied' | 'away' | 'no-reply' };

export interface RunOptions {
  /** A node's endpoint on the harness MCP server; `chargeTo` is the reply its questions count against. */
  mcpUrl?: (nodeId: string, chargeTo?: string) => string | null;
  /** ask_node questions one user message allows without approval (HARNESS_ASK_LIMIT). */
  askLimit?: number;
  /** How long a question waits for the user's approval before it counts as unanswered. */
  approvalTimeoutMs?: number;
}

export const DEFAULT_ASK_LIMIT = 3;
// The CLI gives up on an MCP tool call after 30 minutes (the timeout in its --mcp-config).
const APPROVAL_TIMEOUT_MS = 25 * 60_000;

/**
 * Runs model replies on the server, one per node at a time, independent of any open page.
 * Pages watch a run by subscribing; leaving the page only unsubscribes. The reply is saved when
 * it finishes (or whatever arrived, if it fails or is stopped).
 */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly repo: Repository;
  private readonly llm: LLMProvider;
  private readonly workspaces: Workspaces;
  private readonly worktrees: Worktrees;
  /** The account's usage limit as last reported (it applies to every node). */
  private limit: UsageLimit | null = null;
  /** Nodes whose model-written title is being generated. */
  private readonly titling = new Set<string>();
  /** Merge nodes drafting their results, and why the last attempt failed (until it is retried). */
  private readonly merges = new Map<string, MergeJob>();
  private readonly mergeErrors = new Map<string, string>();
  /** Result drafts running, by node, so two merges of the same node share one. */
  private readonly drafts = new Map<string, Promise<MergedResult>>();
  /** A node's endpoint on the harness MCP server (null: no MCP tools). */
  private readonly mcpUrl: (nodeId: string) => string | null;
  readonly askLimit: number;
  private readonly approvalTimeoutMs: number;

  constructor(repo: Repository, llm: LLMProvider, workspaces: Workspaces, worktrees: Worktrees, options: RunOptions = {}) {
    this.repo = repo;
    this.llm = llm;
    this.workspaces = workspaces;
    this.worktrees = worktrees;
    this.mcpUrl = options.mcpUrl ?? (() => null);
    this.askLimit = options.askLimit ?? DEFAULT_ASK_LIMIT;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  isRunning(nodeId: string): boolean {
    return this.runs.has(nodeId);
  }

  /** A reply is running, or (a merge node) its results are being drafted. */
  isBusy(nodeId: string): boolean {
    return this.runs.has(nodeId) || this.merges.has(nodeId);
  }

  /**
   * A merge node that hasn't started its first message: drafting its results, or stopped (the
   * error says why; Retry starts it again). Null for other nodes.
   */
  mergeState(node: DagNode, messageCount: number): MergeState | null {
    const job = this.merges.get(node.id);
    if (job) return { running: true, startedAt: job.startedAt, activity: job.activity, error: null };
    if (node.mergePrompt === null || messageCount > 0) return null;
    return {
      running: false,
      startedAt: null,
      activity: null,
      error: this.mergeErrors.get(node.id) ?? 'The merge stopped before its results were written (was the app closed?).',
    };
  }

  /**
   * Draft the result of each node a merge node merges (in the background), save them on the merge
   * node, then send its first message. A node that is replying is waited for; a node whose stored
   * result still covers all its messages isn't drafted again.
   */
  startMerge(nodeId: string): void {
    const node = this.repo.getNode(nodeId);
    if (!node) throw notFound('Node');
    if (node.mergePrompt === null || this.repo.listMessages(nodeId).length > 0) throw conflict('This merge has already started.');
    if (this.isBusy(nodeId)) throw conflict('This merge is already running.');
    const job: MergeJob = { startedAt: new Date().toISOString(), activity: 'Starting', abort: new AbortController() };
    this.merges.set(nodeId, job);
    this.mergeErrors.delete(nodeId);
    void this.runMerge(node, job);
  }

  private async runMerge(node: DagNode, job: MergeJob): Promise<void> {
    const signal = job.abort.signal;
    const state = new Map<string, 'waiting' | 'drafting' | 'done'>(node.parentIds.map((id) => [id, 'waiting']));
    const update = () => {
      const waiting = [...state].find(([id, s]) => s === 'waiting' && this.isBusy(id));
      const done = [...state.values()].filter((s) => s === 'done').length;
      job.activity = waiting
        ? `Waiting for "${this.repo.getNode(waiting[0])?.title ?? 'a node'}" to finish`
        : `Writing the results: ${done} of ${state.size} done`;
    };
    try {
      update();
      const results = await Promise.all(node.parentIds.map(async (id) => {
        await this.whenIdle(id, signal, update);
        state.set(id, 'drafting');
        update();
        const result = await this.resultOf(id, signal);
        state.set(id, 'done');
        update();
        return result;
      }));
      this.merges.delete(node.id);
      if (!this.repo.getNode(node.id)) return; // deleted meanwhile (the project was reset)
      this.repo.setMergeResults(node.id, results);
      this.start(node.id, node.mergePrompt!);
    } catch (err) {
      const stopped = signal.aborted;
      job.abort.abort(); // stop the other drafts
      this.merges.delete(node.id);
      if (!this.repo.getNode(node.id)) return;
      if (err instanceof MergeError) {
        this.mergeErrors.set(node.id, err.message);
      } else if (stopped) {
        this.mergeErrors.set(node.id, 'The merge was stopped.');
      } else {
        console.error(`[merge] node ${node.id}:`, err);
        const error = classifyError(err, this.limit?.resetsAt ?? null);
        this.noteFailure(error);
        this.mergeErrors.set(node.id, `Could not write the results: ${error.message}`);
      }
    }
  }

  /** Wait until nothing runs on the node (a reply, or its own merge). */
  private async whenIdle(nodeId: string, signal: AbortSignal, onWait: () => void): Promise<void> {
    while (this.isBusy(nodeId)) {
      if (signal.aborted) throw new Error('The merge was stopped.');
      onWait();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** The node's result for a merge: the stored one if it covers all its messages, else a new draft. */
  private resultOf(nodeId: string, signal: AbortSignal): Promise<MergedResult> {
    const node = this.repo.getNode(nodeId);
    if (!node) return Promise.reject(new MergeError('A merged node no longer exists.'));
    const graph = this.repo.snapshot(node.projectId);
    const messages = graph.messages(nodeId);
    if (!messages.some((m) => m.role === 'assistant')) {
      return Promise.reject(new MergeError(`"${node.title}" has no replies yet, so there is nothing to merge from it. Retry once it has one.`));
    }
    if (node.result && node.resultUpto === messages.length) {
      return Promise.resolve({ nodeId, upto: node.resultUpto, result: node.result });
    }
    const running = this.drafts.get(nodeId);
    if (running) return running;

    const ctx: ReplyContext = {
      nodeId,
      workDir: this.workspaces.prepare(this.repo.getProject(node.projectId)!),
      request: buildChatRequest(graph, nodeId, [{ role: 'user', content: DRAFT_RESULT_INSTRUCTION }]),
      message: DRAFT_RESULT_INSTRUCTION,
      session: planSession(graph, nodeId),
      model: node.model,
      effort: node.effort,
      edit: null, // drafting runs without tools
      mcpUrl: null,
    };
    const upto = messages.length;
    const draft = this.llm
      .draftResult(ctx, signal)
      .then((result) => {
        this.repo.setResult(nodeId, result, upto);
        return { nodeId, upto, result };
      })
      .finally(() => this.drafts.delete(nodeId));
    this.drafts.set(nodeId, draft);
    return draft;
  }

  /** When the node's reply started and what it is doing, or null if nothing is running. */
  status(nodeId: string): RunStatus | null {
    const run = this.runs.get(nodeId);
    return run ? { startedAt: run.startedAt, activity: run.activity, approval: this.approvalOf(run) } : null;
  }

  /**
   * May the reply running on `nodeId` ask another node now? Each user message allows `askLimit`
   * questions; after that a question waits until the user allows it (which grants `askLimit` again)
   * or denies it, or counts as unanswered after a while (the user is probably away). Questions
   * asked while others wait join them, so one decision covers all of them.
   * `from`: the asking node's title, when a node asked by this reply asks further (it counts here).
   */
  allowAsk(nodeId: string, ask: { nodeTitle: string; from: string | null; question: string }, signal: AbortSignal): Promise<AskOutcome> {
    const run = this.runs.get(nodeId);
    if (!run) return Promise.resolve({ decision: 'no-reply' });
    if (run.asksLeft > 0) {
      run.asksLeft--;
      return Promise.resolve({ decision: 'allowed', freeLeft: run.asksLeft });
    }
    return new Promise((resolve) => {
      if (!run.waiting) {
        run.waiting = {
          asks: [],
          expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
          timer: setTimeout(() => this.settleAsks(run, 'away'), this.approvalTimeoutMs),
        };
      }
      const entry = {
        ...ask,
        decide: (d: AskDecision) => resolve(d === 'allowed' ? { decision: 'allowed', freeLeft: run.asksLeft } : { decision: d }),
      };
      run.waiting.asks.push(entry);
      // The question was given up (the CLI stopped): it no longer waits.
      signal.addEventListener('abort', () => {
        if (!run.waiting?.asks.includes(entry)) return;
        run.waiting.asks = run.waiting.asks.filter((a) => a !== entry);
        if (run.waiting.asks.length === 0) this.settleAsks(run, 'denied');
        else this.emit(run, { type: 'approval', approval: this.approvalOf(run) });
        resolve({ decision: 'denied' });
      }, { once: true });
      run.activity = 'Waiting for your approval';
      this.emit(run, { type: 'approval', approval: this.approvalOf(run) });
    });
  }

  /** The user allowed or denied the questions the node's reply waits on. False if none wait. */
  decideAsks(nodeId: string, allow: boolean): boolean {
    const run = this.runs.get(nodeId);
    return run ? this.settleAsks(run, allow ? 'allowed' : 'denied') : false;
  }

  private settleAsks(run: Run, decision: AskDecision): boolean {
    const waiting = run.waiting;
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    run.waiting = null;
    // Allowing resets the count: the waiting questions use the first of the newly free ones.
    if (decision === 'allowed') run.asksLeft = Math.max(0, this.askLimit - waiting.asks.length);
    run.activity = 'Thinking';
    this.emit(run, { type: 'approval', approval: null });
    for (const a of waiting.asks) a.decide(decision);
    return true;
  }

  private approvalOf(run: Run) {
    const w = run.waiting;
    if (!w) return null;
    return { asks: w.asks.map(({ nodeTitle, from, question }) => ({ nodeTitle, from, question })), limit: this.askLimit, expiresAt: w.expiresAt };
  }

  private emit(run: Run, event: ChatStreamEvent): void {
    run.listeners.forEach((l) => l(event));
  }

  isTitling(nodeId: string): boolean {
    return this.titling.has(nodeId);
  }

  /** The usage limit, if close to it or reached; null once a known reset time has passed. */
  usage(): UsageLimit | null {
    if (this.limit?.resetsAt && Date.parse(this.limit.resetsAt) <= Date.now()) this.limit = null;
    return this.limit;
  }

  /** Record a failed model call made outside a run (e.g. a result draft), in case it hit the limit. */
  noteFailure(error: ProviderError): void {
    if (error.kind === 'usage_limit') this.limitReached(error.resetsAt);
  }

  /**
   * Save the user message and start the reply in the background. Returns the saved message.
   * Attachments must already be validated (`Workspaces.validate`).
   */
  start(nodeId: string, content: string, attachments: Attachment[] = []): Message {
    const node = this.requireWritable(nodeId);
    // Plan the provider session before saving the message (it depends on what the node had so far).
    const session = planSession(this.repo.snapshot(node.projectId), nodeId);
    const userMessage = this.repo.addMessage(nodeId, 'user', content, { attachments });
    this.launch(node, session, withAttachments(content, attachments));
    return userMessage;
  }

  /**
   * Answer the node's last message again: it got no reply (the reply failed or was stopped early).
   * A merge node that stopped before its first message starts the merge again.
   */
  retry(nodeId: string): void {
    const pending = this.repo.getNode(nodeId);
    if (pending?.mergePrompt != null && this.repo.listMessages(nodeId).length === 0) return this.startMerge(nodeId);
    const node = this.requireWritable(nodeId);
    const graph = this.repo.snapshot(node.projectId);
    const last = graph.messages(nodeId).at(-1);
    if (last?.role !== 'user') throw conflict('The last message already has a reply.');
    this.launch(node, planSession(graph, nodeId, { retry: true }), withAttachments(last.content, last.attachments));
  }

  /**
   * Watch a node's running reply. The listener first gets a snapshot of the reply so far (unless
   * `snapshot: false`), then every new event.
   * Returns an unsubscribe function, or null if nothing is running.
   */
  subscribe(nodeId: string, listener: Listener, { snapshot = true } = {}): (() => void) | null {
    const run = this.runs.get(nodeId);
    if (!run) return null;
    if (snapshot) {
      listener({
        type: 'snapshot',
        text: run.text,
        toolCalls: [...run.toolCalls.values()],
        thinking: run.thinking,
        startedAt: run.startedAt,
        approval: this.approvalOf(run),
      });
    }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /**
   * Attach branches the model proposed (fork_branches) to the node's running reply, replacing an
   * earlier proposal. False if no reply is running there.
   */
  propose(nodeId: string, proposal: ForkProposal): boolean {
    const run = this.runs.get(nodeId);
    if (!run) return false;
    run.proposal = proposal;
    return true;
  }

  /** Stop a running reply (what arrived so far is kept), or a merge drafting its results. */
  stop(nodeId: string): void {
    this.runs.get(nodeId)?.abort.abort();
    this.merges.get(nodeId)?.abort.abort();
  }

  private requireWritable(nodeId: string): DagNode {
    const node = this.repo.getNode(nodeId);
    if (!node) throw notFound('Node');
    if (this.runs.has(nodeId)) throw conflict('A reply is already being generated for this node.');
    if (this.merges.has(nodeId)) throw conflict('This merge is still writing its results; it starts on its own when they are done.');
    if (node.mergePrompt !== null && node.mergeResults === null) {
      throw conflict('This merge has not finished writing its results. Retry it first.');
    }
    return node;
  }

  /** Start answering the node's last (already saved) user message. A node marked done is open again. */
  private launch(node: DagNode, session: SessionPlan, message: string): void {
    if (node.status === 'finished') this.repo.setStatus(node.id, 'open');
    const workDir = this.workspaces.prepare(this.repo.getProject(node.projectId)!);
    const request = buildChatRequest(this.repo.snapshot(node.projectId), node.id);
    const run: Run = {
      nodeId: node.id,
      startedAt: new Date().toISOString(),
      activity: 'Starting',
      text: '',
      toolCalls: new Map(),
      thinking: false,
      sessionId: null,
      model: null,
      proposal: null,
      asksLeft: this.askLimit,
      waiting: null,
      listeners: new Set(),
      abort: new AbortController(),
    };
    this.runs.set(node.id, run);
    void this.execute(run, { nodeId: node.id, workDir, request, message, session, model: node.model, effort: node.effort, edit: null, mcpUrl: this.mcpUrl(node.id) });
  }

  /**
   * Give the run the node's own editable copy of the project (creating it if needed; a provider
   * that can't edit runs read-only). The first message that runs
   * with it tells the model where it is.
   */
  private async prepareEdit(run: Run, ctx: ReplyContext): Promise<ReplyContext> {
    const node = this.repo.getNode(ctx.nodeId)!;
    if (!this.llm.canEdit) return ctx;
    run.activity = 'Preparing files';
    const project = this.repo.getProject(node.projectId)!;
    const copy = await this.worktrees.ensure(project, this.repo.snapshot(node.projectId), node).catch((err: unknown) => {
      throw new Error(`Could not prepare this node's copy of the project: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!node.gitBranch) this.repo.setGitInfo(node.id, copy.branch, null);
    const firstReply = !this.repo.listMessages(node.id).some((m) => m.role === 'assistant');
    const message = copy.created || firstReply
      ? `${editNote({ dir: copy.editDir, branch: copy.branch, merged: copy.merged, conflicts: copy.conflicts, fromProject: copy.fromProject })}\n\n${ctx.message}`
      : ctx.message;
    return { ...ctx, message, edit: { dir: copy.editDir } };
  }

  /** Save what the model changed in the node's copy as a commit, and the count for the graph card. */
  private async commitEdits(nodeId: string, userMessage: string): Promise<void> {
    const node = this.repo.getNode(nodeId);
    if (!node?.gitBranch) return;
    const project = this.repo.getProject(node.projectId)!;
    try {
      const summary = userMessage.split('\n')[0].slice(0, 72);
      await this.worktrees.commit(project, nodeId, `${node.title}: ${summary}`);
      this.repo.setGitInfo(nodeId, node.gitBranch, await this.worktrees.countChanges(project, nodeId));
    } catch (err) {
      console.error(`[git] node ${nodeId}:`, err);
    }
  }

  private async execute(run: Run, baseCtx: ReplyContext): Promise<void> {
    const emit = (event: ChatStreamEvent) => this.emit(run, event);
    let failure: ProviderError | null = null;
    let ctx = baseCtx;

    try {
      ctx = await this.prepareEdit(run, baseCtx);
      for await (const event of this.llm.streamReply(ctx, run.abort.signal)) {
        if (event.type === 'session') {
          run.sessionId = event.sessionId;
        } else if (event.type === 'model') {
          run.model = event.model;
        } else if (event.type === 'usage') {
          // Not shown or stored yet; scripts/check-cache reads it from the provider directly.
        } else if (event.type === 'limit') {
          this.limit = event.limit;
        } else if (event.type === 'thinking') {
          run.thinking = true;
          run.activity = 'Thinking';
          emit({ type: 'thinking' });
        } else if (event.type === 'tool') {
          // Remember where in the text the call started (updates of the same call keep it).
          const offset = run.toolCalls.get(event.call.id)?.offset ?? run.text.length;
          const call = { ...this.withNodeTitle(event.call, run.nodeId), offset };
          run.toolCalls.set(call.id, call);
          run.activity = call.status === 'running' ? toolActivity(call) : 'Thinking';
          emit({ type: 'tool', call });
        } else {
          run.thinking = false;
          run.activity = 'Writing';
          run.text += event.text;
          emit({ type: 'delta', text: event.text });
        }
      }
    } catch (err) {
      if (!run.abort.signal.aborted) {
        console.error(`[run] node ${run.nodeId}:`, err);
        failure = classifyError(err, this.limit?.resetsAt ?? null);
      }
    }

    // Questions still waiting for approval can't be answered any more (the reply ended or was stopped).
    this.settleAsks(run, 'denied');

    // Commit file changes before the run counts as finished, so a fork right after starts from them.
    if (ctx.edit) await this.commitEdits(run.nodeId, baseCtx.message);

    // Save the reply, or whatever arrived before a failure or Stop (also on a node deleted
    // mid-reply, so restoring it brings the reply back; not if the node is gone, e.g. the project
    // was reset).
    this.runs.delete(run.nodeId);
    const hasContent = run.text !== '' || run.toolCalls.size > 0;
    const node = this.repo.getNode(run.nodeId, { includeDeleted: true });
    // Keep the session only if the reply got somewhere. A first reply that failed before writing
    // anything leaves no session behind, so a retry starts that conversation over cleanly.
    if (node && run.sessionId && (hasContent || !failure)) this.repo.setSessionId(run.nodeId, run.sessionId);
    const saved = hasContent && node
      ? this.repo.addMessage(run.nodeId, 'assistant', run.text, { toolCalls: [...run.toolCalls.values()], model: run.model, forkProposal: run.proposal })
      : null;

    if (failure) {
      if (failure.kind === 'usage_limit') this.limitReached(failure.resetsAt);
      emit({ type: 'error', error: failure.message, kind: failure.kind, resetsAt: failure.resetsAt });
    } else if (saved) {
      if (this.limit?.status === 'reached') this.limit = null; // a reply went through, so it has reset
      emit({ type: 'done', message: saved });
      if (node) this.maybeTitle(node, ctx.workDir);
    } else {
      emit({ type: 'error', error: 'Stopped before any reply arrived.' });
    }
  }

  /** An ask_node call names the node by id; show its title (also for an id the model shortened). */
  private withNodeTitle(call: ToolCall, nodeId: string): ToolCall {
    if (!call.node || call.node.title) return call;
    const projectId = this.repo.getNode(nodeId)?.projectId;
    const ref = call.node.id;
    const target = this.repo.getNode(ref) ?? (projectId && ref.length >= 6 ? this.repo.listNodes(projectId).find((n) => n.id.startsWith(ref)) : null);
    return target ? { ...call, node: { id: target.id, title: target.title } } : call;
  }

  private limitReached(resetsAt: string | null): void {
    const known = this.limit?.status === 'reached' ? this.limit : null;
    this.limit = {
      status: 'reached',
      resetsAt: resetsAt ?? known?.resetsAt ?? null,
      limitType: known?.limitType ?? null,
      utilization: 1,
    };
  }

  /**
   * After a node's first reply, let a small model replace a title taken from the prompt with a
   * short one. Runs in the background; a rename by the user in the meantime wins.
   */
  private maybeTitle(node: DagNode, workDir: string): void {
    if (node.titleSource !== 'prompt' || !this.llm.suggestTitle) return;
    const messages = this.repo.listMessages(node.id);
    if (messages.filter((m) => m.role === 'assistant').length !== 1) return;
    const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
    const reply = messages.find((m) => m.role === 'assistant')?.content ?? '';

    this.titling.add(node.id);
    this.llm
      .suggestTitle({ prompt, reply, workDir }, AbortSignal.timeout(90_000))
      .then((raw) => {
        const title = cleanTitle(raw);
        if (title && this.repo.getNode(node.id)?.titleSource === 'prompt') this.repo.setTitle(node.id, title, 'model');
      })
      .catch((err: unknown) => console.error(`[title] node ${node.id}:`, err))
      .finally(() => this.titling.delete(node.id));
  }
}

/** A merge that can't go on for a reason the user can act on (not a model failure). */
class MergeError extends Error {}
