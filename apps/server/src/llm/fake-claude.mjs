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
  log({ argv });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const text = JSON.parse(line).message.content;
    log({ message: text });
    if (text.includes('crash')) process.exit(3);

    out({ type: 'system', subtype: 'init', session_id: sessionId });
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
    out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    for (const word of ['echo: ', text.slice(-20)]) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } } });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId });
  });
} else {
  // One-shot mode (result drafts): read the prompt from stdin, answer with structured output.
  let prompt = '';
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', () => {
    log({ argv, prompt });
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
