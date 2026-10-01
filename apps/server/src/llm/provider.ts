import type { BranchResult } from '@harness/shared';
import type { ChatRequest } from '../dag/prompt.ts';

export type ReplyEvent = { type: 'thinking' } | { type: 'text'; text: string };

/**
 * What the app needs from a model provider. Each provider (Claude, and later others)
 * implements this with its own official SDK, so the rest of the app is provider-neutral.
 */
export interface LLMProvider {
  /** Shown in logs and the UI, e.g. "anthropic:claude-opus-5-5". */
  readonly label: string;
  /** Stream the assistant's reply to a conversation that ends with a user turn. */
  streamReply(request: ChatRequest, signal: AbortSignal): AsyncIterable<ReplyEvent>;
  /** Write a branch's result report from its full context (the request ends with the instruction). */
  draftResult(request: ChatRequest, signal: AbortSignal): Promise<BranchResult>;
}
