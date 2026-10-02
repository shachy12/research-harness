import type { BranchResult } from '@harness/shared';
import { ProviderError } from './errors.ts';
import type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent } from './provider.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Used when no API key is configured, so the app can still be clicked through.
 * Replies explain how to connect a real model; a message mentioning "search" shows a sample
 * search, so the tool display can be tried out. Results are drafted from the last reply.
 * "[test:limit]" in a message acts as if the usage limit was reached, "[test:warning]" as if it is close.
 * It offers Claude's model ids so the pickers can be tried out, and says which one it was asked for.
 */
export class PlaceholderProvider implements LLMProvider {
  readonly label = 'placeholder (no API key)';
  readonly kind = 'placeholder';
  private readonly wordDelayMs: number;

  /** `wordDelayMs` slows the reply down, e.g. to test what the UI shows during a long reply. */
  constructor(wordDelayMs = 15) {
    this.wordDelayMs = wordDelayMs;
  }

  async models(): Promise<ModelCatalog> {
    const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    return {
      models: [
        { id: 'claude-opus-5-5', efforts: [...all] },
        { id: 'claude-sonnet-5-5', efforts: [...all] },
        { id: 'claude-fable-5-1', efforts: [...all] },
        { id: 'claude-haiku-4-5', efforts: [] },
      ],
      defaultModel: 'claude-opus-5-5',
      defaultEffort: 'high',
      forkKeepsCache: true,
    };
  }

  async *streamReply({ request, model, effort }: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    yield { type: 'model', model: model ?? 'claude-opus-5-5' };
    const question = request.turns.at(-1)?.content ?? '';
    if (question.includes('[test:limit]')) {
      const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
      await pause(20 * this.wordDelayMs);
      yield { type: 'limit', limit: { status: 'reached', resetsAt, limitType: 'five_hour', utilization: 1 } };
      throw new ProviderError('usage_limit', 'Claude usage limit reached (placeholder test).', resetsAt);
    }
    if (question.includes('[test:warning]')) {
      const resetsAt = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
      yield { type: 'limit', limit: { status: 'warning', resetsAt, limitType: 'seven_day', utilization: 0.25 } };
    }
    if (/search/i.test(question)) {
      const call = { id: `sample-${Date.now()}`, name: 'web_search', input: question.slice(0, 80), status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      await pause(40 * this.wordDelayMs);
      yield {
        type: 'tool',
        call: { ...call, status: 'done', results: [{ title: 'Sample result (placeholder, not a real search)', url: 'https://example.com/' }] },
      };
    }

    const text =
      `No model is connected yet, so this is a placeholder reply. ` +
      `This node's prompt has ${request.turns.length} turns, including everything it inherits. ` +
      `Asked for model ${model ?? 'default'}, effort ${effort ?? 'default'}. ` +
      `To get real answers, set ANTHROPIC_API_KEY in the .env file at the repository root and restart the server.` +
      // Echo the message, so formatting (Markdown, math) can be tried out.
      `\n\nYour message, rendered:\n\n${question.split('\n\n[')[0]}`;
    for (const word of text.split(/(?<= )/)) {
      if (signal.aborted) return;
      await pause(this.wordDelayMs);
      yield { type: 'text', text: word };
    }
  }

  async suggestTitle({ prompt }: { prompt: string }): Promise<string> {
    await pause(10 * this.wordDelayMs);
    return `Placeholder: ${prompt.split(/\s+/).slice(0, 4).join(' ')}`;
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
