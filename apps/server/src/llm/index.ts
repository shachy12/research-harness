import { AnthropicProvider, type Effort } from './anthropic.ts';
import { ClaudeCodeProvider, findClaudeExecutable } from './claude-code.ts';
import { PlaceholderProvider } from './placeholder.ts';
import type { LLMProvider } from './provider.ts';

export type { LLMProvider, ReplyContext, ReplyEvent } from './provider.ts';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Pick the provider from environment variables. A settings UI replaces this later.
 *   HARNESS_PROVIDER=claude-code   the Claude Code CLI with your own Claude login
 *   HARNESS_PROVIDER=anthropic     the Claude API (needs ANTHROPIC_API_KEY)
 *   unset                          the API if a key is set, otherwise a placeholder
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const choice = env.HARNESS_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'placeholder');

  if (choice === 'claude-code') {
    // Runs in each project's working folder (passed per call), so it can read the project's files.
    return new ClaudeCodeProvider({ command: findClaudeExecutable(env), model: env.HARNESS_MODEL });
  }

  if (choice === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('HARNESS_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
    const effort = (env.HARNESS_EFFORT ?? 'high') as Effort;
    if (!EFFORTS.includes(effort)) throw new Error(`HARNESS_EFFORT must be one of ${EFFORTS.join(', ')}`);
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.HARNESS_MODEL ?? 'claude-opus-5-5',
      effort,
    });
  }

  if (choice === 'placeholder') return new PlaceholderProvider(Number(env.HARNESS_PLACEHOLDER_DELAY_MS ?? 15));
  throw new Error(`Unknown HARNESS_PROVIDER "${choice}". Use claude-code, anthropic or placeholder.`);
}
