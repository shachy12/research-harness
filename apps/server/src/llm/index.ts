import { AnthropicProvider, type Effort } from './anthropic.ts';
import { PlaceholderProvider } from './placeholder.ts';
import type { LLMProvider } from './provider.ts';

export type { LLMProvider, ReplyEvent } from './provider.ts';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Pick the provider from environment variables. A settings UI replaces this later. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  if (!env.ANTHROPIC_API_KEY) return new PlaceholderProvider();

  const effort = (env.HARNESS_EFFORT ?? 'high') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`HARNESS_EFFORT must be one of ${EFFORTS.join(', ')}`);

  return new AnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.HARNESS_MODEL ?? 'claude-opus-5-5',
    effort,
  });
}
