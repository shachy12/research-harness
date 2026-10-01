// Request body schemas. The server validates with them; the web app can reuse them for forms.
import { z } from 'zod/v4';

export const branchResultSchema = z.object({
  findings: z.string().trim().min(1, 'Findings are required'),
  evidence: z.string().trim(),
  openQuestions: z.string().trim(),
  confidence: z.enum(['low', 'medium', 'high']),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message is empty'),
});

export const renameNodeSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const forkSchema = z.object({
  titles: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
});

export const mergeSchema = z.object({
  parentIds: z.array(z.string().min(1)).min(2, 'Select at least two branches'),
  title: z.string().trim().min(1).max(200),
});

export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type RenameNodeBody = z.infer<typeof renameNodeSchema>;
export type ForkBody = z.infer<typeof forkSchema>;
export type MergeBody = z.infer<typeof mergeSchema>;
