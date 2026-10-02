import { EFFORTS, type Effort } from '@harness/shared';
import { AnthropicProvider } from './anthropic.ts';
import { ClaudeCodeProvider, findClaudeExecutable } from './claude-code.ts';
import { PlaceholderProvider } from './placeholder.ts';
import type { LLMProvider } from './provider.ts';

export type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent } from './provider.ts';

/**
 * What nodes without their own setting use, unless HARNESS_MODEL / HARNESS_EFFORT say otherwise.
 * Both providers always send them, so the model never depends on the account's current default.
 */
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT: Effort = 'high';

/** HARNESS_EFFORT, checked; undefined when unset. */
function effortFromEnv(env: NodeJS.ProcessEnv): Effort | undefined {
  const effort = env.HARNESS_EFFORT as Effort | undefined;
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`HARNESS_EFFORT must be one of ${EFFORTS.join(', ')}`);
  return effort;
}

/**
 * Pick the provider from environment variables. A settings UI replaces this later.
 *   HARNESS_PROVIDER=claude-code   the Claude Code CLI with your own Claude login
 *   HARNESS_PROVIDER=anthropic     the Claude API (needs ANTHROPIC_API_KEY)
 *   unset                          the API if a key is set, otherwise a placeholder
 * HARNESS_MODEL / HARNESS_EFFORT are the defaults for nodes without their own model setting.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const choice = env.HARNESS_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'placeholder');

  if (choice === 'claude-code') {
    // Runs in each project's working folder (passed per call), so it can read the project's files.
    return new ClaudeCodeProvider({
      command: findClaudeExecutable(env),
      model: env.HARNESS_MODEL ?? DEFAULT_MODEL,
      effort: effortFromEnv(env) ?? DEFAULT_EFFORT,
    });
  }

  if (choice === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('HARNESS_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.HARNESS_MODEL ?? DEFAULT_MODEL,
      effort: effortFromEnv(env) ?? DEFAULT_EFFORT,
    });
  }

  if (choice === 'placeholder') return new PlaceholderProvider(Number(env.HARNESS_PLACEHOLDER_DELAY_MS ?? 15));
  throw new Error(`Unknown HARNESS_PROVIDER "${choice}". Use claude-code, anthropic or placeholder.`);
}
