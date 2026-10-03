// A stand-in for the Claude Code CLI, used by claude-code.test.ts.
// Speaks the same stream-json protocol for the events the provider reads, and appends each run's
// arguments and received messages to the file in FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const resume = flag('--resume');
const sessionId = resume ? (argv.includes('--fork-session') ? `fork-of-${resume}` : resume) : 'new-session';
const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

if (flag('--input-format') === 'stream-json') {
  // Which CLAUDE* variables reached us (the provider must not pass a parent Claude Code session's on).
  log({ argv, cwd: process.cwd(), claudeEnv: Object.keys(process.env).filter((k) => /^CLAUDE/i.test(k)) });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const text = JSON.parse(line).message.content;
    log({ message: text });
    if (text.includes('crash')) process.exit(3);

    out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') ?? 'claude-opus-5-5' });
    if (text.includes('hit-limit')) {
      // What the CLI sends when the usage limit is reached.
      const limitText = "You've hit your limit · resets 5pm";
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, rateLimitType: 'five_hour' } });
      out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: limitText }] } });
      out({ type: 'result', subtype: 'success', is_error: true, result: limitText, session_id: sessionId });
      return;
    }
    if (text.includes('warn')) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1790000000, rateLimitType: 'seven_day', utilization: 0.25 } });
    }
    if (text.includes('search')) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'q' } }] } });
      out({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'Web search results for query: "q"\n\nLinks: [{"title":"Doc [1]","url":"https://example.org/a"}]\n\nSummary...',
          }],
        },
      });
    }
    if (text.includes('compile')) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'latexmk -pdf main.tex', description: 'Compile' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'x'.repeat(5000) + 'Output written on main.pdf' }] } });
    }
    if (text.includes('attached')) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:\\p\\.harness\\uploads\\paper.pdf' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'PDF content' }] }] } });
    }
    out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    for (const word of ['echo: ', text.slice(-20)]) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } } });
    }
    out({
      type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId,
      usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    });
  });
} else {
  // One-shot mode (result drafts): read the prompt from stdin, answer with structured output.
  let prompt = '';
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', () => {
    log({ argv, prompt });
    if (prompt.includes('hit-limit')) {
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm" });
      return;
    }
    if (argv.includes('haiku')) {
      out({ type: 'result', subtype: 'success', is_error: false, result: '"Fake Title."' });
      return;
    }
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: sessionId,
      structured_output: { findings: 'drafted by fake', evidence: '', openQuestions: '', confidence: 'medium' },
    });
  });
}
