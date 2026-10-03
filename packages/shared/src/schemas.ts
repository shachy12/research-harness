// Request body schemas. The server validates with them; the web app can reuse them for forms.
import { z } from 'zod/v4';
import type { Effort } from './types.ts';

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

/** Effort levels, lowest to highest. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[];

/** A model id (null: the provider's default). The server checks it against the provider's list. */
const modelField = z.string().trim().min(1).max(100).nullable();
const effortField = z.enum(EFFORTS).nullable();

/**
 * A new project. `folder` is an existing folder the model works in (e.g. a LaTeX repository); it
 * can't be changed later, because Claude Code sessions belong to the folder they were made in.
 */
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name the project').max(120),
  folder: z.string().trim().min(1).optional(),
  /** The root node's model and effort (left out or null: the default). Branches copy them. */
  model: modelField.optional(),
  effort: effortField.optional(),
});

/** Rename and/or archive a project (PATCH /projects/:id). */
export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.archived !== undefined, 'Nothing to change');

/** A folder to check before creating a project on it (see `FolderGit`). */
export const checkFolderSchema = z.object({
  folder: z.string().trim().min(1),
});

export const renameNodeSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/** The last message of a node the user has seen. */
export const markReadSchema = z.object({
  messageId: z.string().min(1),
});

/** Change the model and effort a node's next replies use. */
export const modelSettingsSchema = z.object({
  model: modelField,
  effort: effortField,
});

/**
 * Each branch's prompt is its first message (sent with its attachments). Its title is `title` when
 * given (a branch made from a list item is named after the item), else the prompt, shortened.
 * `model` / `effort` left out means the parent's.
 */
export const forkSchema = z.object({
  branches: z
    .array(z.object({
      prompt: z.string().trim().min(1),
      title: z.string().trim().min(1).max(200).optional(),
      attachments: z.array(attachmentSchema).max(20).default([]),
      model: modelField.optional(),
      effort: effortField.optional(),
    }))
    .min(1)
    .max(12),
});

/**
 * The merged node starts working on `prompt` (its first message) right away. Without a `title`, it
 * gets a default one that the model may later replace. `model` / `effort` left out: the branches'
 * setting, or if they differ, the model first by name (`mergeModelSettings`).
 */
export const mergeSchema = z.object({
  parentIds: z.array(z.string().min(1)).min(2, 'Select at least two branches'),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1, 'Write the first message'),
  model: modelField.optional(),
  effort: effortField.optional(),
});

export const mergePreviewSchema = z.object({
  parentIds: z.array(z.string().min(1)).min(2),
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
export type ModelSettingsBody = z.infer<typeof modelSettingsSchema>;
