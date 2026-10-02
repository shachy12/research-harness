// Node titles written by a small model (see LLMProvider.suggestTitle).

export const TITLE_SYSTEM_PROMPT =
  'You name research conversations. Reply with a title of 3 to 7 words and nothing else: no quotes, no trailing period, no "Title:".';

/** What the title model sees: the conversation's first message and the start of its reply. */
export function titleRequest(prompt: string, reply: string): string {
  return [
    'Write a short, specific title for this research conversation.',
    `First message:\n${prompt.slice(0, 2000)}`,
    `Start of the reply:\n${reply.slice(0, 1500)}`,
  ].join('\n\n');
}

/** Clean up what the model wrote: first line, no quotes, Markdown or label. Empty if unusable. */
export function cleanTitle(raw: string): string {
  const line = raw.trim().split('\n')[0] ?? '';
  const title = line
    .replace(/^#+\s*/, '')
    .replace(/^title:\s*/i, '')
    .replace(/\*\*|__/g, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  return title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title;
}
