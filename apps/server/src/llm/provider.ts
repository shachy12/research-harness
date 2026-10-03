import type { BranchResult, Effort, ModelOption, ToolCall, UsageLimit } from '@harness/shared';
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
  | { type: 'limit'; limit: UsageLimit | null }
  /** The model actually answering (its full id), as the provider reports it; saved on the reply. */
  | { type: 'model'; model: string }
  /** Input tokens of the reply, split by prompt cache use (sent once, at the end; see check-cache). */
  | { type: 'usage'; usage: TokenUsage };

export interface TokenUsage {
  /** Read without the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  /** The node's model and effort; null means the provider's default. */
  model: string | null;
  effort: Effort | null;
  /**
   * The node's editable copy of the project (null if the provider can't edit): the model may create
   * and change files inside `dir` and nowhere else. Null: read-only, as before.
   */
  edit: { dir: string } | null;
  /**
   * This node's endpoint on the harness MCP server (fork_branches, ask_node; see tools/harness.ts),
   * or null when the server doesn't offer it (tests). Providers without MCP support ignore it.
   */
  mcpUrl: string | null;
}

/** The models a provider offers and what a node without its own setting uses. */
export interface ModelCatalog {
  models: ModelOption[];
  defaultModel: string;
  defaultEffort: Effort;
  /** See ModelsResponse.forkKeepsCache. */
  forkKeepsCache: boolean;
}

/**
 * What the app needs from a model provider. Each provider (Claude API, Claude Code, later others)
 * implements this with its own official SDK or CLI, so the rest of the app is provider-neutral.
 */
export interface LLMProvider {
  /** The backend, shown in the header, e.g. "Claude Code" (models are chosen per node and project). */
  readonly label: string;
  /** e.g. 'claude-code', 'anthropic', 'placeholder'. */
  readonly kind: string;
  /** The provider can let the model edit files (see `ReplyContext.edit`). */
  readonly canEdit: boolean;
  /** The models the pickers offer (may ask the provider's API). */
  models(): Promise<ModelCatalog>;
  /** Stream the assistant's reply to the new message. */
  streamReply(ctx: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent>;
  /**
   * Answer a question from another node, from this node's full context (ask_node). Like
   * draftResult, it must not change the node's conversation. Absent: the provider can't.
   */
  askNode?(ctx: ReplyContext, signal: AbortSignal): Promise<{ answer: string; usage: TokenUsage | null }>;
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
