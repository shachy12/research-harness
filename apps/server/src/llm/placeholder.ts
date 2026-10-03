import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { BranchResult, ToolCall } from '@harness/shared';
import { callHarnessTool } from '../tools/harness.ts';
import { ProviderError } from './errors.ts';
import type { LLMProvider, ModelCatalog, ReplyContext, ReplyEvent, TokenUsage } from './provider.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Used when no API key is configured, so the app can still be clicked through.
 * Replies explain how to connect a real model; a message mentioning "search" shows a sample
 * search, so the tool display can be tried out. Results are drafted from the last reply.
 * "[test:limit]" in a message acts as if the usage limit was reached, "[test:warning]" as if it is close.
 * "[test:edit]" adds a line to `placeholder-notes.md` in the node's editable copy, so the changes view and Apply can be tried out.
 * "[test:shell]" shows a sample shell command with its output (nothing is run).
 * "[test:fork]" proposes branches through the harness MCP server: one per "- " line in the message, else three samples.
 * "[test:ask <node id>]" asks that node through the harness MCP server; "[test:ask]" asks the first node a merge note lists.
 * It offers Claude's model ids so the pickers can be tried out, and says which one it was asked for.
 */
export class PlaceholderProvider implements LLMProvider {
  readonly label = 'placeholder (no API key)';
  readonly kind = 'placeholder';
  readonly canEdit = true;
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

  async *streamReply({ request, model, effort, edit, mcpUrl }: ReplyContext, signal: AbortSignal): AsyncIterable<ReplyEvent> {
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
    if (question.includes('[test:edit]') && edit) {
      const file = path.join(edit.dir, 'placeholder-notes.md');
      const call = { id: `edit-${Date.now()}`, name: 'edit_file', input: file, status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      await pause(20 * this.wordDelayMs);
      appendFileSync(file, `- ${new Date().toISOString()}: ${question.split('\n')[0].slice(0, 80)}\n`);
      yield { type: 'tool', call: { ...call, status: 'done' } };
    }
    if (question.includes('[test:shell]')) {
      // Shows a shell command row with output; nothing is run.
      const call = { id: `shell-${Date.now()}`, name: 'shell', input: 'latexmk -pdf main.tex', status: 'running' as const, results: [] };
      yield { type: 'tool', call };
      await pause(20 * this.wordDelayMs);
      yield { type: 'tool', call: { ...call, status: 'done', output: 'Latexmk: All targets (main.pdf) are up-to-date\n(placeholder, nothing was run)' } };
    }
    if (question.includes('[test:fork]') && mcpUrl) {
      const items = question.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
      const branches = (items.length ? items : ['First direction', 'Second direction', 'Third direction'])
        .map((item) => ({ prompt: `Investigate: ${item}`, title: item.slice(0, 60) }));
      yield* this.harnessCall(mcpUrl, 'fork_branches', { branches }, branches.map((b) => b.title).join(' · '));
    }
    const ask = /\[test:ask(?: ([0-9a-f-]+))?\]/.exec(question);
    if (ask && mcpUrl) {
      const nodeId = ask[1] ?? /\(node ([0-9a-f-]{36})\)/.exec(request.turns.map((t) => t.content).join('\n'))?.[1] ?? 'none';
      const q = 'What did this conversation find? (placeholder test)';
      yield* this.harnessCall(mcpUrl, 'ask_node', { nodeId, question: q }, q, { id: nodeId, title: '' });
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

  /** Call a harness tool for real (over MCP) and show it as a tool row. */
  private async *harnessCall(url: string, name: 'fork_branches' | 'ask_node', args: Record<string, unknown>, input: string, node?: ToolCall['node']): AsyncIterable<ReplyEvent> {
    const call: ToolCall = { id: `${name}-${Date.now()}`, name, input, status: 'running', results: [], ...(node ? { node } : {}) };
    yield { type: 'tool', call };
    try {
      const { text, isError } = await callHarnessTool(url, name, args);
      yield { type: 'tool', call: { ...call, status: isError ? 'error' : 'done', ...(isError ? { error: text } : name === 'ask_node' ? { output: text } : {}) } };
    } catch (err) {
      yield { type: 'tool', call: { ...call, status: 'error', error: err instanceof Error ? err.message : String(err) } };
    }
  }

  async askNode({ request, message }: ReplyContext): Promise<{ answer: string; usage: TokenUsage | null }> {
    await pause(40 * this.wordDelayMs);
    const question = message.split('\n\n').at(-1) ?? message;
    return { answer: `Placeholder answer from a node with ${request.turns.length} turns of context, to: ${question}`, usage: null };
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
