import { EFFORTS, type Effort } from '@harness/shared';
import { ClaudeCodeProvider, findClaudeExecutable } from './claude-code.ts';
import { PlaceholderProvider } from './placeholder.ts';
import type { LLMProvider } from './provider.ts';

export type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent } from './provider.ts';

/**
 * What nodes without their own setting use, unless HARNESS_MODEL / HARNESS_EFFORT say otherwise.
 * Both providers always send them, so the model never depends on the account's current default.
 */
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_EFFORT: Effort = 'low';

/** HARNESS_MODELS: comma-separated model ids to offer besides the built-in ones. */
function modelsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.HARNESS_MODELS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

/** HARNESS_EFFORT, checked; undefined when unset. */
function effortFromEnv(env: NodeJS.ProcessEnv): Effort | undefined {
  const effort = env.HARNESS_EFFORT as Effort | undefined;
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`HARNESS_EFFORT must be one of ${EFFORTS.join(', ')}`);
  return effort;
}

/**
 * Pick the provider from environment variables. A settings UI replaces this later.
 *   unset or HARNESS_PROVIDER=claude-code   the Claude Code CLI (your Claude login, Bedrock, Vertex, …)
 *   HARNESS_PROVIDER=placeholder            no model, for tests and previews
 * HARNESS_MODEL / HARNESS_EFFORT are the defaults for nodes without their own model setting;
 * HARNESS_MODELS adds more model ids (e.g. Bedrock ones) to the pickers.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const choice = env.HARNESS_PROVIDER ?? 'claude-code';

  if (choice === 'claude-code') {
    // Runs in each project's working folder (passed per call), so it can read the project's files.
    return new ClaudeCodeProvider({
      command: findClaudeExecutable(env),
      model: env.HARNESS_MODEL ?? DEFAULT_MODEL,
      extraModels: modelsFromEnv(env),
      effort: effortFromEnv(env) ?? DEFAULT_EFFORT,
    });
  }

  if (choice === 'placeholder') return new PlaceholderProvider(Number(env.HARNESS_PLACEHOLDER_DELAY_MS ?? 15));
  throw new Error(`Unknown HARNESS_PROVIDER "${choice}". Use claude-code or placeholder.`);
}
