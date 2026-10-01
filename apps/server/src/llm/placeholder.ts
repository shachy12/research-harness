import type { BranchResult } from '@harness/shared';
import type { ChatRequest } from '../dag/prompt.ts';
import type { LLMProvider, ReplyEvent } from './provider.ts';

/**
 * Used when no API key is configured, so the app can still be clicked through.
 * Replies explain how to connect a real model; results are drafted from the last reply.
 */
export class PlaceholderProvider implements LLMProvider {
  readonly label = 'placeholder (no API key)';

  async *streamReply(request: ChatRequest, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const text =
      `No model is connected yet, so this is a placeholder reply. ` +
      `This node's prompt has ${request.turns.length} turns, including everything it inherits. ` +
      `To get real answers, set ANTHROPIC_API_KEY in the .env file at the repository root and restart the server.`;
    for (const word of text.split(/(?<= )/)) {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 15));
      yield { type: 'text', text: word };
    }
  }

  async draftResult(request: ChatRequest): Promise<BranchResult> {
    const lastReply = request.turns.findLast((t) => t.role === 'assistant')?.content ?? '';
    return {
      findings: lastReply.slice(0, 500) || 'No findings yet.',
      evidence: '',
      openQuestions: '',
      confidence: 'low',
    };
  }
}
