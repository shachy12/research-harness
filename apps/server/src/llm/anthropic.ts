import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type BranchResult, type Effort, EFFORTS, type ModelOption, type ToolCall, branchResultSchema } from '@harness/shared';
import type { ChatTurn } from '../dag/prompt.ts';
import type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent } from './provider.ts';
import { TITLE_SYSTEM_PROMPT, titleRequest } from './title.ts';

export type { Effort };

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

// Small and fast: titles cost a fraction of a cent.
const TITLE_MODEL = 'claude-haiku-4-5-20251001';

// A long server-side tool loop can pause; we resume it this many times at most.
const MAX_CONTINUATIONS = 5;

// The model list is asked from the API at most this often.
const MODELS_TTL_MS = 60 * 60_000;

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
  readonly kind = 'anthropic';
  readonly canEdit = false; // no file tools yet
  private readonly client: Anthropic;
  private readonly options: AnthropicOptions;
  private modelList: { models: ModelOption[]; fetchedAt: number } | null = null;

  constructor(options: AnthropicOptions) {
    this.options = options;
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.label = 'Claude API';
  }

  /** The account's models from the Models API, with the effort levels each supports. */
  async models(): Promise<ModelCatalog> {
    if (!this.modelList || Date.now() - this.modelList.fetchedAt > MODELS_TTL_MS) {
      const models: ModelOption[] = [];
      for await (const m of this.client.models.list()) {
        const effort = m.capabilities?.effort;
        models.push({ id: m.id, efforts: effort?.supported ? EFFORTS.filter((level) => effort[level]?.supported) : [] });
      }
      this.modelList = { models, fetchedAt: Date.now() };
    }
    return {
      models: this.modelList.models,
      defaultModel: this.options.model,
      defaultEffort: this.options.effort,
      forkKeepsCache: true,
    };
  }

  async *streamReply({ request, model, effort }: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    const messages = toMessages(request.turns);
    const calls = new Map<string, ToolCall>();
    let wroteText = false;

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: model ?? this.options.model,
          max_tokens: 64000,
          system: request.system,
          messages,
          tools: RESEARCH_TOOLS,
          // Also caches the growing conversation, so follow-up turns in the same node reuse it.
          cache_control: { type: 'ephemeral' },
          output_config: this.effortConfig(model, effort),
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
      // With a refusal fallback this can be another model than the one asked for.
      if (attempt === 0) yield { type: 'model', model: final.model };
      const u = final.usage;
      yield { type: 'usage', usage: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
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

  async draftResult({ request, model, effort }: ReplyContext, signal: AbortSignal): Promise<BranchResult> {
    const response = await this.client.beta.messages.parse(
      {
        model: model ?? this.options.model,
        max_tokens: 16000,
        system: request.system,
        messages: toMessages(request.turns),
        output_config: { ...this.effortConfig(model, effort), format: zodOutputFormat(branchResultSchema) },
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

  /** The effort to send, or none for a model known not to take one (e.g. Haiku 4.5). */
  private effortConfig(model: string | null, effort: Effort | null): { effort?: Effort } {
    const id = model ?? this.options.model;
    const known = this.modelList?.models.find((m) => m.id === id);
    return known && known.efforts.length === 0 ? {} : { effort: effort ?? this.options.effort };
  }

  async suggestTitle({ prompt, reply }: { prompt: string; reply: string }, signal: AbortSignal): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: TITLE_MODEL,
        max_tokens: 50,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: titleRequest(prompt, reply) }],
      },
      { signal },
    );
    return response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  }
}
