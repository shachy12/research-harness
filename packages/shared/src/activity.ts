import type { ToolCall } from './types.ts';

const TOOL_ACTIVITY: Record<string, string> = {
  web_search: 'Searching the web',
  web_fetch: 'Reading a web page',
  read_file: 'Reading',
  find_files: 'Looking through files',
  search_files: 'Searching files',
};

/** What a running tool call means, for progress indicators: "Searching the web: BIKE parameters", "Reading main.tex". */
export function toolActivity(call: ToolCall): string {
  const what = TOOL_ACTIVITY[call.name] ?? 'Using a tool';
  if (call.name === 'read_file') return `${what} ${call.input.split(/[\\/]/).pop()}`;
  return call.input ? `${what}: ${call.input}` : what;
}

/** 0:42, 2:05, 1:02:10 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
