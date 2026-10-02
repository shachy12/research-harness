import { type Attachment, type ChatStreamEvent, type Message, type RunStatus, type ToolCall, toolActivity } from '@harness/shared';
import { buildChatRequest, withAttachments } from './dag/prompt.ts';
import { planSession } from './dag/session.ts';
import type { Repository } from './db/repository.ts';
import type { LLMProvider } from './llm/index.ts';
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

  /**
   * Save the user message and start the reply in the background. Returns the saved message.
   * Attachments must already be validated (`Workspaces.validate`).
   */
  start(nodeId: string, content: string, attachments: Attachment[] = []): Message {
    const node = this.repo.getNode(nodeId);
    if (!node) throw notFound('Node');
    if (node.status === 'frozen') throw conflict('This node was forked, so it is frozen. Continue in one of its branches.');
    if (node.status === 'finished') throw conflict('This branch is finished.');
    if (this.runs.has(nodeId)) throw conflict('A reply is already being generated for this node.');

    // Plan the provider session before saving the message (it depends on what the node had so far).
    const session = planSession(this.repo.snapshot(node.projectId), nodeId);
    const workDir = this.workspaces.prepare(this.repo.getProject(node.projectId)!);
    const userMessage = this.repo.addMessage(nodeId, 'user', content, { attachments });
    const request = buildChatRequest(this.repo.snapshot(node.projectId), nodeId);
    const message = withAttachments(content, attachments);

    const run: Run = {
      nodeId,
      startedAt: new Date().toISOString(),
      activity: 'Starting',
      text: '',
      toolCalls: new Map(),
      thinking: false,
      listeners: new Set(),
      abort: new AbortController(),
    };
    this.runs.set(nodeId, run);
    void this.execute(run, { nodeId, workDir, request, message, session });
    return userMessage;
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

  private async execute(run: Run, ctx: Parameters<LLMProvider['streamReply']>[0]): Promise<void> {
    const emit = (event: ChatStreamEvent) => run.listeners.forEach((l) => l(event));
    let failure: string | null = null;

    try {
      for await (const event of this.llm.streamReply(ctx, run.abort.signal)) {
        if (event.type === 'session') {
          this.repo.setSessionId(run.nodeId, event.sessionId);
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
        failure = err instanceof Error ? err.message : 'The model request failed';
      }
    }

    // Save the reply, or whatever arrived before a failure or Stop
    // (unless the node itself is gone, e.g. the project was reset mid-reply).
    this.runs.delete(run.nodeId);
    const hasContent = run.text || run.toolCalls.size > 0;
    const saved = hasContent && this.repo.getNode(run.nodeId)
      ? this.repo.addMessage(run.nodeId, 'assistant', run.text, { toolCalls: [...run.toolCalls.values()] })
      : null;

    if (failure) emit({ type: 'error', error: failure });
    else if (saved) emit({ type: 'done', message: saved });
    else emit({ type: 'error', error: 'Stopped before any reply arrived.' });
  }
}
