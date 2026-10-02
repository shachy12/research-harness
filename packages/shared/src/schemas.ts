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

/**
 * A new project. `folder` is an existing folder the model works in (e.g. a LaTeX repository); it
 * can't be changed later, because Claude Code sessions belong to the folder they were made in.
 */
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name the project').max(120),
  folder: z.string().trim().min(1).optional(),
});

export const renameProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const renameNodeSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/** The last message of a node the user has seen. */
export const markReadSchema = z.object({
  messageId: z.string().min(1),
});

/**
 * Each branch's prompt is its first message (sent with its attachments). Its title is `title` when
 * given (a branch made from a list item is named after the item), else the prompt, shortened.
 */
export const forkSchema = z.object({
  branches: z
    .array(z.object({
      prompt: z.string().trim().min(1),
      title: z.string().trim().min(1).max(200).optional(),
      attachments: z.array(attachmentSchema).max(20).default([]),
    }))
    .min(1)
    .max(12),
});

/**
 * The merged node starts working on `prompt` (its first message) right away. Without a `title`, it
 * gets a default one that the model may later replace.
 */
export const mergeSchema = z.object({
  parentIds: z.array(z.string().min(1)).min(2, 'Select at least two branches'),
  title: z.string().trim().min(1).max(200).optional(),
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

/** A merged node's title until the user or the model names it. */
export function defaultMergeTitle(branchTitles: string[]): string {
  return `Synthesis: ${branchTitles.join(' + ')}`.slice(0, 120);
}

export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type RenameNodeBody = z.infer<typeof renameNodeSchema>;
export type ForkBody = z.infer<typeof forkSchema>;
export type MergeBody = z.infer<typeof mergeSchema>;
