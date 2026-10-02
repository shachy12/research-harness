import type { Message } from './types.ts';

type MessageRef = Pick<Message, 'id' | 'role'>;

/**
 * Index of the first assistant reply the user has not read yet, or -1 if there is none.
 * `readUpto` is the id of the last message read; null means nothing was read yet.
 */
export function firstUnreadIndex(messages: MessageRef[], readUpto: string | null): number {
  const readIndex = readUpto === null ? -1 : messages.findIndex((m) => m.id === readUpto);
  return messages.findIndex((m, i) => i > readIndex && m.role === 'assistant');
}

/** How many assistant replies come after the last message read. */
export function unreadCount(messages: MessageRef[], readUpto: string | null): number {
  const readIndex = readUpto === null ? -1 : messages.findIndex((m) => m.id === readUpto);
  return messages.filter((m, i) => i > readIndex && m.role === 'assistant').length;
}
