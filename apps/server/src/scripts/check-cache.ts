/**
 * Live check that branches still share the prompt cache with the real Claude Code CLI.
 *   npm run check:cache -w @harness/server [-- <model>]     (default model: claude-haiku-4-5)
 *
 * Uses a little of your Claude usage limit (a few short replies over a ~15K-token conversation,
 * on Haiku by default), so it is not part of `npm test`. Run it after updating Claude Code or
 * changing how the provider starts the CLI. Exits with code 1 if a required check fails, 2 if it
 * stopped early (e.g. at the usage limit). Results so far (CLI 2.1.287, 2026-10-02): the
 * required checks pass on Haiku 4.5, Sonnet 5.5 and Opus 5.5. Without CLAUDE_CODE_TETHER_LIVE=false
 * (see `cliEnv`), Sonnet 5.5's forks and resumes read only the system prompt from the cache; if
 * these fail again, check whether that variable still exists in the CLI.
 *
 * It goes through ClaudeCodeProvider itself, with CLAUDE* variables set as if started from inside
 * Claude Code (they broke caching before; the provider must remove them).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { branchStartNote } from '../dag/prompt.ts';
import type { SessionPlan } from '../dag/session.ts';
import { ClaudeCodeProvider, findClaudeExecutable } from '../llm/claude-code.ts';
import type { ReplyContext, TokenUsage } from '../llm/provider.ts';

const model = process.argv[2] ?? 'claude-haiku-4-5';
const workDir = mkdtempSync(path.join(tmpdir(), 'harness-cache-check-'));
Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'check-cache', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
const provider = new ClaudeCodeProvider({ command: findClaudeExecutable(), model, effort: 'high' });

// A conversation long enough to be cached (Haiku caches from 4,096 tokens). Fresh each run, so
// nothing is left over from an earlier run.
const stamp = Date.now();
const filler = Array.from({ length: 600 }, (_, i) => `Note ${i} (${stamp}): the archive lists item ${i * 7} under shelf ${i % 53}.`).join('\n');

const NEW: SessionPlan = { mode: 'new', sessionId: null, preamble: null, transcript: [] };
const forkOf = (sessionId: string, title: string): SessionPlan => ({ mode: 'fork', sessionId, preamble: branchStartNote(title), transcript: [] });

async function reply(nodeId: string, message: string, session: SessionPlan) {
  const ctx: ReplyContext = { nodeId, workDir, message, session, request: { system: '', turns: [] }, model, effort: null };
  let usage: TokenUsage | null = null;
  let sessionId = '';
  for await (const e of provider.streamReply(ctx, new AbortController().signal)) {
    if (e.type === 'usage') usage = e.usage;
    if (e.type === 'session') sessionId = e.sessionId;
  }
  if (!usage) throw new Error(`no usage reported for ${nodeId}`);
  return { usage, sessionId };
}

const total = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite;
const describe = (u: TokenUsage) => `read ${u.cacheRead} from the cache, wrote ${u.cacheWrite}, uncached ${u.input}`;
let failed = false;
function check(required: boolean, label: string, ok: boolean, u: TokenUsage) {
  console.log(`${ok ? 'ok  ' : required ? 'FAIL' : 'note'}  ${label}: ${describe(u)}`);
  if (required && !ok) failed = true;
}

console.log(`Claude Code prompt-cache check on ${model}\n`);
// A failure (e.g. the usage limit) ends the check with what was measured so far.
process.on('uncaughtException', (err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  provider.dispose();
  process.exit(2);
});

// 1. Inside one live process, the next turn reads the conversation from the cache.
const first = await reply('parent', `Read these notes, then just say "ready".\n\n${filler}`, NEW);
const second = await reply('parent', 'Say OK.', NEW);
check(true, 'next turn in the same process', second.usage.cacheRead >= 0.8 * total(first.usage), second.usage);
const parentSize = total(second.usage);
provider.release('parent'); // forking stops the parent's process, as the app does

// 2. Sibling branches started one after another: the later one reads what the earlier one wrote
//    (their first messages differ only after the shared history).
const a = await reply('branch-a', 'Which shelf holds item 70?', forkOf(first.sessionId, 'Shelf of item 70'));
const b = await reply('branch-b', 'Which shelf holds item 140?', forkOf(first.sessionId, 'Shelf of item 140'));
check(true, 'second sibling branch (started after the first)', b.usage.cacheRead >= 0.8 * parentSize, b.usage);
void a;

// 3. Sibling branches started at the same moment, as the fork dialog does: both read the
//    parent's cache.
const [c, d] = await Promise.all([
  reply('branch-c', 'Which shelf holds item 210?', forkOf(first.sessionId, 'Shelf of item 210')),
  reply('branch-d', 'Which shelf holds item 280?', forkOf(first.sessionId, 'Shelf of item 280')),
]);
check(true, 'sibling branches started together (first)', c.usage.cacheRead >= 0.8 * parentSize, c.usage);
check(true, 'sibling branches started together (second)', d.usage.cacheRead >= 0.8 * parentSize, d.usage);

// 4. Resuming the parent in a new process (after an idle stop or Stop).
const resumed = await reply('parent', 'Say OK again.', { mode: 'resume', sessionId: first.sessionId, preamble: null, transcript: [] });
check(true, 'parent resumed in a new process', resumed.usage.cacheRead >= 0.8 * parentSize, resumed.usage);

provider.dispose();
console.log(failed ? '\nA required check failed: branches no longer share the prompt cache.' : '\nRequired checks passed.');
process.exit(failed ? 1 : 0);
