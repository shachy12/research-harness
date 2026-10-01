import type { BranchResult } from '@harness/shared';
import type { LLMProvider, ReplyContext, ReplyEvent } from './provider.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Used when no API key is configured, so the app can still be clicked through.
 * Replies explain how to connect a real model; a message mentioning "search" shows a sample
 * search, so the tool display can be tried out. Results are drafted from the last reply.
 */
export class PlaceholderProvider implements LLMProvider {
  readonly label = 'placeholder (no API key)';

  async *streamReply({ request }: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const question = request.turns.at(-1)?.content ?? '';
    if (/search/i.test(question)) {
      const call = { id: `sample-${Date.now()}`, name: 'web_search', input: question.slice(0, 80), status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      await pause(600);
      yield {
        type: 'tool',
        call: { ...call, status: 'done', results: [{ title: 'Sample result (placeholder, not a real search)', url: 'https://example.com/' }] },
      };
    }

    const text =
      `No model is connected yet, so this is a placeholder reply. ` +
      `This node's prompt has ${request.turns.length} turns, including everything it inherits. ` +
      `To get real answers, set ANTHROPIC_API_KEY in the .env file at the repository root and restart the server.`;
    for (const word of text.split(/(?<= )/)) {
      if (signal.aborted) return;
      await pause(15);
      yield { type: 'text', text: word };
    }
  }

  async draftResult({ request }: ReplyContext): Promise<BranchResult> {
    const lastReply = request.turns.findLast((t) => t.role === 'assistant')?.content ?? '';
    return {
      findings: lastReply.slice(0, 500) || 'No findings yet.',
      evidence: '',
      openQuestions: '',
      confidence: 'low',
    };
  }
}
