import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type BranchResult, branchResultSchema } from '@harness/shared';
import type { ChatRequest, ChatTurn } from '../dag/prompt.ts';
import type { LLMProvider, ReplyEvent } from './provider.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
}

// Server-side refusal fallback: if the model declines, the API re-runs the request on a
// suitable fallback model within the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function toMessages(turns: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return turns.map((t) => ({
    role: t.role,
    content: [
      {
        type: 'text',
        text: t.content,
        ...(t.cacheBreakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
  }));
}

export class AnthropicProvider implements LLMProvider {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly options: AnthropicOptions;

  constructor(options: AnthropicOptions) {
    this.options = options;
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.label = `anthropic:${options.model}`;
  }

  async *streamReply(request: ChatRequest, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.options.model,
        max_tokens: 64000,
        system: request.system,
        messages: toMessages(request.turns),
        // Also caches the growing conversation, so follow-up turns in the same node reuse it.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: this.options.effort },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        yield { type: 'thinking' };
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      yield { type: 'text', text: '\n\n[The model declined to answer this request.]' };
    } else if (final.stop_reason === 'max_tokens') {
      yield { type: 'text', text: '\n\n[The reply was cut off at the maximum length.]' };
    }
  }

  async draftResult(request: ChatRequest, signal: AbortSignal): Promise<BranchResult> {
    const response = await this.client.beta.messages.parse(
      {
        model: this.options.model,
        max_tokens: 16000,
        system: request.system,
        messages: toMessages(request.turns),
        output_config: { effort: this.options.effort, format: zodOutputFormat(branchResultSchema) },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      },
      { signal },
    );
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error('The model could not draft a result for this branch. Write it by hand instead.');
    }
    return response.parsed_output;
  }
}
