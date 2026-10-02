import {
  type Attachment,
  type ChatStreamEvent,
  type DagNode,
  type Message,
  type RunStatus,
  type ToolCall,
  type UsageLimit,
  toolActivity,
} from '@harness/shared';
import { buildChatRequest, withAttachments } from './dag/prompt.ts';
import { type SessionPlan, planSession } from './dag/session.ts';
import type { Repository } from './db/repository.ts';
import { type ProviderError, classifyError } from './llm/errors.ts';
import type { LLMProvider, ReplyContext } from './llm/index.ts';
import { cleanTitle } from './llm/title.ts';
import { conflict, notFound } from './routes/errors.ts';
import type { Workspaces } from './workspace.ts';

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
  listeners: Set<Listener>;
  abort: AbortController;
}

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
  /** The account's usage limit as last reported (it applies to every node). */
  private limit: UsageLimit | null = null;
  /** Nodes whose model-written title is being generated. */
  private readonly titling = new Set<string>();

  constructor(repo: Repository, llm: LLMProvider, workspaces: Workspaces) {
    this.repo = repo;
    this.llm = llm;
    this.workspaces = workspaces;
  }

  isRunning(nodeId: string): boolean {
    return this.runs.has(nodeId);
  }

  /** When the node's reply started and what it is doing, or null if nothing is running. */
  status(nodeId: string): RunStatus | null {
    const run = this.runs.get(nodeId);
    return run ? { startedAt: run.startedAt, activity: run.activity } : null;
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

  /** Answer the node's last message again: it got no reply (the reply failed or was stopped early). */
  retry(nodeId: string): void {
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
      });
    }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** Stop a running reply; what arrived so far is kept. */
  stop(nodeId: string): void {
    this.runs.get(nodeId)?.abort.abort();
  }

  private requireWritable(nodeId: string): DagNode {
    const node = this.repo.getNode(nodeId);
    if (!node) throw notFound('Node');
    if (node.status === 'frozen') throw conflict('This node was forked, so it is frozen. Continue in one of its branches.');
    if (node.status === 'finished') throw conflict('This branch is finished.');
    if (this.runs.has(nodeId)) throw conflict('A reply is already being generated for this node.');
    return node;
  }

  /** Start answering the node's last (already saved) user message. */
  private launch(node: DagNode, session: SessionPlan, message: string): void {
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
      listeners: new Set(),
      abort: new AbortController(),
    };
    this.runs.set(node.id, run);
    void this.execute(run, { nodeId: node.id, workDir, request, message, session });
  }

  private async execute(run: Run, ctx: ReplyContext): Promise<void> {
    const emit = (event: ChatStreamEvent) => run.listeners.forEach((l) => l(event));
    let failure: ProviderError | null = null;

    try {
      for await (const event of this.llm.streamReply(ctx, run.abort.signal)) {
        if (event.type === 'session') {
          run.sessionId = event.sessionId;
        } else if (event.type === 'limit') {
          this.limit = event.limit;
        } else if (event.type === 'thinking') {
          run.thinking = true;
          run.activity = 'Thinking';
          emit({ type: 'thinking' });
        } else if (event.type === 'tool') {
          run.toolCalls.set(event.call.id, event.call);
          run.activity = event.call.status === 'running' ? toolActivity(event.call) : 'Thinking';
          emit({ type: 'tool', call: event.call });
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

    // Save the reply, or whatever arrived before a failure or Stop
    // (unless the node itself is gone, e.g. the project was reset mid-reply).
    this.runs.delete(run.nodeId);
    const hasContent = run.text !== '' || run.toolCalls.size > 0;
    const node = this.repo.getNode(run.nodeId);
    // Keep the session only if the reply got somewhere. A first reply that failed before writing
    // anything leaves no session behind, so a retry starts that conversation over cleanly.
    if (node && run.sessionId && (hasContent || !failure)) this.repo.setSessionId(run.nodeId, run.sessionId);
    const saved = hasContent && node
      ? this.repo.addMessage(run.nodeId, 'assistant', run.text, { toolCalls: [...run.toolCalls.values()] })
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
