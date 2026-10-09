import { zValidator } from '@hono/zod-validator';
import {
  type Attachment,
  type ChatStreamEvent,
  type DagNode,
  type Effort,
  type FileContent,
  type NodeChanges,
  type NodeDetail,
  type NodeFiles,
  askDecisionSchema,
  doneSchema,
  forkSchema,
  markReadSchema,
  modelSettingsSchema,
  openInEditorSchema,
  renameNodeSchema,
  sendMessageSchema,
  titleFromPrompt,
} from '@harness/shared';
import path from 'node:path';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { RouteDeps } from '../app.ts';
import { inheritedItems } from '../dag/context.ts';
import { classifyError } from '../llm/errors.ts';
import { cleanTitle } from '../llm/title.ts';
import type { RunManager } from '../runs.ts';
import { EditorNotFoundError } from '../system/editor.ts';
import { safeRelativePath } from '../worktrees.ts';
import { conflict, HttpError, notFound } from './errors.ts';

/**
 * Stream a node's running reply as server-sent events until it ends or the page disconnects.
 * Disconnecting only stops watching; the reply keeps running on the server.
 */
function watchRun(c: Context, runs: RunManager, nodeId: string, first?: ChatStreamEvent) {
  // Subscribe right away (not inside the stream callback), so a fast reply can't end unseen.
  const queue: ChatStreamEvent[] = first ? [first] : [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const unsubscribe = runs.subscribe(
    nodeId,
    (event) => {
      queue.push(event);
      if (event.type === 'done' || event.type === 'error') ended = true;
      notify();
    },
    { snapshot: !first }, // a page that just sent the message doesn't need a snapshot
  );
  if (!unsubscribe) {
    queue.push({ type: 'idle' });
    ended = true;
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      ended = true;
      notify();
    });

    try {
      for (;;) {
        while (queue.length > 0 && !stream.aborted) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
        if (ended || stream.aborted) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      unsubscribe?.();
    }
  });
}

export function nodeRoutes({ repo, llm, runs, workspaces, worktrees, checkModel, openInEditor }: RouteDeps) {
  const requireNode = (id: string) => {
    const node = repo.getNode(id);
    if (!node) throw notFound('Node');
    return node;
  };

  /**
   * The node's files for the Files view. A node that ran before gets its folder back first if an
   * earlier version removed it (nodes finished or deleted back then), so it can be opened again.
   */
  const filesOf = (node: DagNode) => {
    const project = repo.getProject(node.projectId)!;
    return gitOr500('files', node.id, async () => {
      if (node.gitBranch) await worktrees.restore(project, node.id);
      return worktrees.files(project, repo.snapshot(node.projectId), node);
    });
  };

  return new Hono()
    .get('/:nodeId', (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const graph = repo.snapshot(node.projectId);
      const messages = graph.messages(node.id);
      return c.json<NodeDetail>({
        node,
        messages,
        inherited: inheritedItems(graph, node.id),
        childIds: graph.children(node.id).map((n) => n.id),
        forks: forksOf(graph.children(node.id)),
        running: runs.isRunning(node.id),
        run: runs.status(node.id),
        titlePending: runs.isTitling(node.id),
        merge: runs.mergeState(node, messages.length),
        usage: runs.usage(),
      });
    })

    // Rename. A title the user chose is final: the model never replaces it.
    .patch('/:nodeId', zValidator('json', renameNodeSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      repo.setTitle(node.id, c.req.valid('json').title, 'user');
      return c.json(repo.getNode(node.id)!);
    })

    // Change the model and effort for the node's next replies (the history stays as it is).
    .put('/:nodeId/model', zValidator('json', modelSettingsSchema), async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (runs.isRunning(node.id)) throw conflict('Wait for the current reply to finish.');
      const { model, effort } = c.req.valid('json');
      await checkModel(model, effort);
      repo.setModelSettings(node.id, model, effort);
      return c.json(repo.getNode(node.id)!);
    })

    // The user has read up to this message. Only moves forward, so a late or repeated call is harmless.
    .put('/:nodeId/read', zValidator('json', markReadSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const { messageId } = c.req.valid('json');
      if (!repo.listMessages(node.id).some((m) => m.id === messageId)) throw notFound('Message');
      repo.markRead(node.id, messageId);
      return c.json({ ok: true });
    })

    // Ask a small model for a short title (not saved; the rename dialog offers it).
    .post('/:nodeId/title/suggest', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (!llm.suggestTitle) throw new HttpError(501, 'This model provider cannot suggest titles.');
      const messages = repo.listMessages(node.id);
      const prompt = messages.find((m) => m.role === 'user')?.content;
      if (!prompt) throw new HttpError(400, 'This node has no messages to name it after.');
      const reply = messages.find((m) => m.role === 'assistant')?.content ?? '';
      const workDir = workspaces.prepare(repo.getProject(node.projectId)!);
      try {
        const title = cleanTitle(await llm.suggestTitle({ prompt, reply, workDir }, c.req.raw.signal));
        if (!title) throw new Error('The model did not suggest a usable title.');
        return c.json({ title });
      } catch (err) {
        const error = classifyError(err);
        runs.noteFailure(error);
        throw new HttpError(502, error.message);
      }
    })

    // Send a user message: starts the reply on the server and streams it (see ChatStreamEvent).
    .post('/:nodeId/messages', zValidator('json', sendMessageSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const { content, attachments } = c.req.valid('json');
      // A node marked done is open again once it gets a message (RunManager.start).
      const checked = workspaces.validate(repo.getProject(node.projectId)!, attachments);
      if ('error' in checked) throw new HttpError(400, checked.error);
      const userMessage = runs.start(node.id, content, checked);
      return watchRun(c, runs, node.id, { type: 'user', message: userMessage });
    })

    // Watch a reply that is already running (e.g. a branch started by fork).
    .get('/:nodeId/stream', (c) => {
      requireNode(c.req.param('nodeId'));
      return watchRun(c, runs, c.req.param('nodeId'));
    })

    // Answer the last message again after its reply failed or was stopped before writing anything
    // (a merge that stopped while writing its results starts again).
    .post('/:nodeId/retry', (c) => {
      runs.retry(requireNode(c.req.param('nodeId')).id);
      return c.json({ ok: true });
    })

    // Allow or deny the ask_node questions the reply waits on. Allowing frees the usual number again.
    .post('/:nodeId/asks', zValidator('json', askDecisionSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (!runs.decideAsks(node.id, c.req.valid('json').allow)) throw conflict('No questions are waiting for approval.');
      return c.json({ ok: true });
    })

    // Delete a node: it is hidden with its messages kept (`restore` undoes it). Its children become
    // roots (they keep their own conversations and sessions; the graph no longer links them). Its
    // git branch and its folder (worktree) stay; the folder is committed, so nothing in it is lost.
    .delete('/:nodeId', (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const graph = repo.snapshot(node.projectId);
      const merging = graph.children(node.id).find((child) => runs.mergeState(child, graph.messages(child.id).length)?.running);
      if (merging) throw conflict(`"${merging.title}" is still writing the results of a merge with this node. Wait until it has started, or delete that merge first.`);
      runs.stop(node.id);
      llm.release?.(node.id);
      const orphans = repo.deleteNode(node.id);
      if (node.gitBranch) {
        worktrees
          .commit(repo.getProject(node.projectId)!, node.id, `${node.title}: state when deleted`)
          .catch((err: unknown) => console.error(`[git] commit ${node.id}:`, err));
      }
      return c.json({ ok: true, orphans });
    })

    // Undo a delete: the node comes back, and its children that are still roots are attached again.
    .post('/:nodeId/restore', (c) => {
      const restored = repo.restoreNode(c.req.param('nodeId'));
      if (!restored) throw notFound('Deleted node');
      return c.json(restored);
    })

    // Mark the node done (a green marker on its card), or not. Nothing else changes: it can still be
    // messaged (which clears the mark), forked and merged.
    .put('/:nodeId/done', zValidator('json', doneSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      repo.setStatus(node.id, c.req.valid('json').done ? 'finished' : 'open');
      return c.json(repo.getNode(node.id)!);
    })

    // Stop the running reply; what arrived so far is kept.
    .post('/:nodeId/stop', (c) => {
      runs.stop(requireNode(c.req.param('nodeId')).id);
      return c.json({ ok: true });
    })

    // Create branches and start each one working on its first message (with its files) right away.
    // Fork: the node stays open; its branches start from what it has now (see below). With
    // `filesFromProject` their copies of the files start from the project's checked-out branch.
    .post('/:nodeId/fork', zValidator('json', forkSchema), async (c) => {
      const parent = requireNode(c.req.param('nodeId'));
      const busy = () => {
        if (runs.isRunning(parent.id)) throw conflict('Wait for the current reply to finish before forking.');
        if (runs.isBusy(parent.id) || runs.mergeState(parent, repo.listMessages(parent.id).length)) {
          throw conflict('This merge has not started yet, so there is nothing to fork from.');
        }
      };
      busy();

      const project = repo.getProject(parent.projectId)!;
      const { filesFromProject } = c.req.valid('json');
      const branches: { prompt: string; title: string; attachments: Attachment[]; model: string | null; effort: Effort | null }[] = [];
      for (const { prompt, title, attachments, model, effort } of c.req.valid('json').branches) {
        const checked = workspaces.validate(project, attachments);
        if ('error' in checked) throw new HttpError(400, checked.error);
        // A branch keeps its parent's model and effort unless it was given its own.
        const settings = { model: model === undefined ? parent.model : model, effort: effort === undefined ? parent.effort : effort };
        if (model !== undefined || effort !== undefined) await checkModel(settings.model, settings.effort);
        branches.push({ prompt, title: title ?? titleFromPrompt(prompt), attachments: checked, ...settings });
      }
      busy();
      // The parent stays open. Each branch inherits what it has now (its fork point) and forks its
      // session as it is now; the parent's next message continues in a copy (`planSession`).
      const forkPoint = repo.listMessages(parent.id).length;
      const children = repo.transaction(() =>
        branches.map(({ title, model, effort }) =>
          repo.createNode({ projectId: parent.projectId, title, parentIds: [parent.id], model, effort, forkPoint, forkSession: parent.sessionId, filesFromProject }),
        ),
      );
      llm.release?.(parent.id); // its next message starts a new process on the copy
      // Branches starting from the project's files get their git branch at their first run (`ensure`).
      if (parent.gitBranch && !filesFromProject) {
        // Queued before the children's copies are made: they start from the parent's files as they are now.
        worktrees
          .fork(project, parent.id, children.map((child) => child.id), `${parent.title}: forked`)
          .catch((err: unknown) => console.error(`[git] fork ${parent.id}:`, err));
      }
      children.forEach((child, i) => runs.start(child.id, branches[i].prompt, branches[i].attachments));
      return c.json(children, 201);
    })

    // What applying the node's file changes would bring into the project (null: it has none).
    .get('/:nodeId/changes', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (!node.gitBranch) return c.json<NodeChanges | null>(null);
      try {
        return c.json<NodeChanges | null>(await worktrees.changes(repo.getProject(node.projectId)!, node.id));
      } catch (err) {
        console.error(`[git] changes ${node.id}:`, err);
        throw new HttpError(500, err instanceof Error ? err.message : 'Could not read the changes');
      }
    })

    // The files of the node's copy, for the Files view (read-only: the user edits in VS Code).
    .get('/:nodeId/files', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      return c.json<NodeFiles>(await filesOf(node));
    })

    // One file of the node's copy: text (up to a size), or what kind of file it is.
    .get('/:nodeId/files/content', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const file = c.req.query('path') ?? '';
      const project = repo.getProject(node.projectId)!;
      const read = await gitOr500('read', node.id, () => worktrees.readFile(project, repo.snapshot(node.projectId), node, file, MAX_TEXT_BYTES));
      if (!read) throw notFound('File');
      const base = { path: file, size: read.size, text: null };
      if (imageType(file)) return c.json<FileContent>({ ...base, kind: 'image' });
      if (!read.bytes) return c.json<FileContent>({ ...base, kind: 'too-large' });
      if (read.bytes.subarray(0, 8000).includes(0)) return c.json<FileContent>({ ...base, kind: 'binary' });
      return c.json<FileContent>({ ...base, kind: 'text', text: new TextDecoder().decode(read.bytes) });
    })

    // An image of the node's copy, for the Files view's preview. Never run as a page (an SVG could hold scripts).
    .get('/:nodeId/files/raw', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const file = c.req.query('path') ?? '';
      const type = imageType(file);
      if (!type) throw new HttpError(400, 'Only images can be previewed.');
      const project = repo.getProject(node.projectId)!;
      const read = await gitOr500('read', node.id, () => worktrees.readFile(project, repo.snapshot(node.projectId), node, file, MAX_IMAGE_BYTES));
      if (!read) throw notFound('File');
      if (!read.bytes) throw new HttpError(413, 'This image is too large to preview.');
      return c.body(new Uint8Array(read.bytes), 200, {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
    })

    // Open the node's copy in VS Code (and one of its files). It must exist: it is made at the first reply.
    .post('/:nodeId/open-in-editor', zValidator('json', openInEditorSchema), async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const files = await filesOf(node);
      if (!files.folder) throw conflict("This node has no copy of the files yet: it gets one with its first reply.");
      const { path: file } = c.req.valid('json');
      const rel = file === undefined ? null : safeRelativePath(file);
      if (file !== undefined && !rel) throw new HttpError(400, 'Not a file of this node.');
      try {
        await openInEditor(files.folder, rel ? path.join(files.folder, rel) : undefined);
      } catch (err) {
        throw new HttpError(err instanceof EditorNotFoundError ? 404 : 500, err instanceof Error ? err.message : 'Could not start VS Code.');
      }
      return c.json({ ok: true });
    })

    // Merge the node's branch into the project's current branch. Conflicts leave the project as it was.
    .post('/:nodeId/apply', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (!node.gitBranch) throw new HttpError(400, 'This node has no file changes.');
      if (runs.isRunning(node.id)) throw conflict('Wait for the current reply to finish.');
      const project = repo.getProject(node.projectId)!;
      await worktrees.commit(project, node.id, `${node.title}: state when applied`);
      const result = await worktrees.apply(project, node.id, node.title);
      if (!result.ok) throw new HttpError(409, result.error);
      repo.setGitInfo(node.id, node.gitBranch, await worktrees.countChanges(project, node.id));
      return c.json({ ok: true });
    });
}

/** The largest text file the Files view shows, and the largest image it previews. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

/** The media type of an image file the Files view previews (by extension), or null. */
function imageType(file: string): string | null {
  return IMAGE_TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/** Run a git step for a route; a failure becomes a 500 with git's message (and is logged). */
async function gitOr500<T>(what: string, nodeId: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    console.error(`[git] ${what} ${nodeId}:`, err);
    throw new HttpError(500, err instanceof Error ? err.message : `Could not read the files`);
  }
}

/** Where branches were forked off a node, grouped by fork point (merge nodes are not forks). */
function forksOf(children: DagNode[]): NodeDetail['forks'] {
  const byPoint = new Map<number, string[]>();
  for (const c of children) {
    if (c.parentIds.length !== 1 || c.forkPoint === null) continue;
    byPoint.set(c.forkPoint, [...(byPoint.get(c.forkPoint) ?? []), c.id]);
  }
  return [...byPoint].sort(([a], [b]) => a - b).map(([at, childIds]) => ({ at, childIds }));
}
