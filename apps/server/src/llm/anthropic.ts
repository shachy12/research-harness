import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type BranchResult, type ToolCall, branchResultSchema } from '@harness/shared';
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

// Web search and fetch run on Anthropic's servers; these versions filter results with code
// before they reach the context. The limits cap cost per reply.
const RESEARCH_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 10 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10 },
];

// A long server-side tool loop can pause; we resume it this many times at most.
const MAX_CONTINUATIONS = 5;

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

/** Turn finished content blocks into tool-call updates for the UI. */
function toolUpdate(block: Anthropic.Beta.BetaContentBlock, calls: Map<string, ToolCall>): ToolCall | null {
  if (block.type === 'server_tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) {
    const input = block.input as { query?: string; url?: string };
    const call: ToolCall = {
      id: block.id,
      name: block.name,
      input: input.query ?? input.url ?? '',
      status: 'running',
      results: [],
    };
    calls.set(call.id, call);
    return call;
  }

  if (block.type === 'web_search_tool_result') {
    const call = calls.get(block.tool_use_id);
    if (!call) return null;
    if (Array.isArray(block.content)) {
      call.status = 'done';
      call.results = block.content.map((r) => ({ title: r.title, url: r.url }));
    } else {
      call.status = 'error';
      call.error = block.content.error_code;
    }
    return call;
  }

  if (block.type === 'web_fetch_tool_result') {
    const call = calls.get(block.tool_use_id);
    if (!call) return null;
    if (block.content.type === 'web_fetch_result') {
      call.status = 'done';
      call.results = [{ title: block.content.content.title ?? block.content.url, url: block.content.url }];
    } else {
      call.status = 'error';
      call.error = block.content.error_code;
    }
    return call;
  }

  return null;
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
    const messages = toMessages(request.turns);
    const calls = new Map<string, ToolCall>();
    let wroteText = false;

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.options.model,
          max_tokens: 64000,
          system: request.system,
          messages,
          tools: RESEARCH_TOOLS,
          // Also caches the growing conversation, so follow-up turns in the same node reuse it.
          cache_control: { type: 'ephemeral' },
          output_config: { effort: this.options.effort },
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking') yield { type: 'thinking' };
          // Separate text written after a search from the text before it.
          if (event.content_block.type === 'text' && wroteText) yield { type: 'text', text: '\n\n' };
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          wroteText = true;
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'content_block_stop') {
          const block = stream.currentMessage?.content[event.index];
          const call = block && toolUpdate(block, calls);
          if (call) yield { type: 'tool', call: { ...call } };
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === 'pause_turn') {
        // The server paused a long tool loop. Send the partial turn back unchanged and it resumes.
        messages.push({ role: 'assistant', content: final.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      if (final.stop_reason === 'refusal') {
        yield { type: 'text', text: '\n\n[The model declined to answer this request.]' };
      } else if (final.stop_reason === 'max_tokens') {
        yield { type: 'text', text: '\n\n[The reply was cut off at the maximum length.]' };
      }
      return;
    }
    yield { type: 'text', text: '\n\n[The research loop ran too long and was stopped. Ask a narrower question.]' };
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
