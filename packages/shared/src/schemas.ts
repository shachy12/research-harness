// Request body schemas. The server validates with them; the web app can reuse them for forms.
import { z } from 'zod/v4';

export const branchResultSchema = z.object({
  findings: z.string().trim().min(1, 'Findings are required'),
  evidence: z.string().trim(),
  openQuestions: z.string().trim(),
  confidence: z.enum(['low', 'medium', 'high']),
});

export const attachmentSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: z.enum(['file', 'folder']).optional(),
  fileCount: z.number().int().nonnegative().optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message is empty'),
  /** Files uploaded beforehand with POST /projects/:id/uploads. */
  attachments: z.array(attachmentSchema).max(20).default([]),
});

/** Largest file accepted by the upload endpoint. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Limits for one uploaded folder. */
export const MAX_FOLDER_BYTES = 200 * 1024 * 1024;
export const MAX_FOLDER_FILES = 2000;

/** Folder and file names skipped when uploading a folder (version control, dependencies, OS clutter). */
export function isSkippedUploadName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === '__MACOSX' || name === 'Thumbs.db';
}

export const renameNodeSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/** Each prompt becomes a branch: its first message, and (shortened) its title. */
export const forkSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).min(1).max(12),
});

/** The merged node starts working on `prompt` (its first message) right away. */
export const mergeSchema = z.object({
  parentIds: z.array(z.string().min(1)).min(2, 'Select at least two branches'),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1, 'Write the first message'),
});

/** A short node title from a prompt: its first line, cut at a word boundary. */
export function titleFromPrompt(prompt: string, max = 80): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type RenameNodeBody = z.infer<typeof renameNodeSchema>;
export type ForkBody = z.infer<typeof forkSchema>;
export type MergeBody = z.infer<typeof mergeSchema>;
