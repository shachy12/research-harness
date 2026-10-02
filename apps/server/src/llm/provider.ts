import type { BranchResult, ToolCall, UsageLimit } from '@harness/shared';
import type { ChatRequest } from '../dag/prompt.ts';
import type { SessionPlan } from '../dag/session.ts';

export type ReplyEvent =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  /** A tool call started (status 'running') or finished; later events replace earlier ones with the same id. */
  | { type: 'tool'; call: ToolCall }
  /** The provider's session for this node (session-based providers); the server stores it on the node. */
  | { type: 'session'; sessionId: string }
  /** The provider reported the usage limit: close to it, reached, or fine again (null). */
  | { type: 'limit'; limit: UsageLimit | null };

/**
 * Everything a provider might need for one model call. Stateless providers (the API) use `request`,
 * the full prompt. Session-based providers (Claude Code) use `session` and `message`.
 */
export interface ReplyContext {
  nodeId: string;
  /** The project's working folder: session-based providers run there (and can read files only there). */
  workDir: string;
  /** Full context as turns, ending with the new message (or the draft instruction). */
  request: ChatRequest;
  /** Just the new user message, including any attachment note (or the draft instruction). */
  message: string;
  session: SessionPlan;
}

/**
 * What the app needs from a model provider. Each provider (Claude API, Claude Code, later others)
 * implements this with its own official SDK or CLI, so the rest of the app is provider-neutral.
 */
export interface LLMProvider {
  /** Shown in logs and the UI, e.g. "anthropic:claude-opus-5-5". */
  readonly label: string;
  /** Stream the assistant's reply to the new message. */
  streamReply(ctx: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent>;
  /** Write a branch's result report from its full context; must not change the node's conversation. */
  draftResult(ctx: ReplyContext, signal: AbortSignal): Promise<BranchResult>;
  /**
   * A short title (3–7 words) for a conversation, from its first message and the start of the
   * reply. Runs on a small, cheap model and leaves the node's conversation untouched.
   */
  suggestTitle?(input: { prompt: string; reply: string; workDir: string }, signal: AbortSignal): Promise<string>;
  /** The node won't receive more messages for now (forked, finished): free any resources held for it. */
  release?(nodeId: string): void;
  /** The server is shutting down. */
  dispose?(): void;
}
