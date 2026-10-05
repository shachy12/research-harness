import { zValidator } from '@hono/zod-validator';
import {
  type Attachment,
  type ChatStreamEvent,
  type DagNode,
  type Effort,
  type NodeChanges,
  type NodeDetail,
  askDecisionSchema,
  branchResultSchema,
  forkSchema,
  markReadSchema,
  modelSettingsSchema,
  renameNodeSchema,
  sendMessageSchema,
  titleFromPrompt,
} from '@harness/shared';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { RouteDeps } from '../app.ts';
import { inheritedItems } from '../dag/context.ts';
import { DRAFT_RESULT_INSTRUCTION, buildChatRequest } from '../dag/prompt.ts';
import { planSession } from '../dag/session.ts';
import { classifyError } from '../llm/errors.ts';
import type { ReplyContext } from '../llm/index.ts';
import { cleanTitle } from '../llm/title.ts';
import type { RunManager } from '../runs.ts';
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

export function nodeRoutes({ repo, llm, runs, workspaces, worktrees, checkModel }: RouteDeps) {
  const requireNode = (id: string) => {
    const node = repo.getNode(id);
    if (!node) throw notFound('Node');
    return node;
  };

  /** A finished node won't edit again: commit its copy and remove it (its branch stays). */
  const retireCopy = (node: DagNode) => {
    if (!node.gitBranch) return;
    worktrees
      .retire(repo.getProject(node.projectId)!, node.id, `${node.title}: final state`)
      .catch((err: unknown) => console.error(`[git] retire ${node.id}:`, err));
  };

  return new Hono()
    .get('/:nodeId', (c) => {
      const node = requireNode(c.req.param('nodeId'));
      const graph = repo.snapshot(node.projectId);
      return c.json<NodeDetail>({
        node,
        messages: graph.messages(node.id),
        inherited: inheritedItems(graph, node.id),
        childIds: graph.children(node.id).map((n) => n.id),
        forks: forksOf(graph.children(node.id)),
        running: runs.isRunning(node.id),
        run: runs.status(node.id),
        titlePending: runs.isTitling(node.id),
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
      if (node.status !== 'open') throw conflict('Only open nodes can change their model.');
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

    // Answer the last message again after its reply failed or was stopped before writing anything.
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

    // Stop the running reply; what arrived so far is kept.
    .post('/:nodeId/stop', (c) => {
      runs.stop(requireNode(c.req.param('nodeId')).id);
      return c.json({ ok: true });
    })

    // Create branches and start each one working on its first message (with its files) right away.
    // Fork: the node stays open; its branches start from what it has now (see below).
    .post('/:nodeId/fork', zValidator('json', forkSchema), async (c) => {
      const parent = requireNode(c.req.param('nodeId'));
      if (runs.isRunning(parent.id)) throw conflict('Wait for the current reply to finish before forking.');

      const project = repo.getProject(parent.projectId)!;
      const branches: { prompt: string; title: string; attachments: Attachment[]; model: string | null; effort: Effort | null }[] = [];
      for (const { prompt, title, attachments, model, effort } of c.req.valid('json').branches) {
        const checked = workspaces.validate(project, attachments);
        if ('error' in checked) throw new HttpError(400, checked.error);
        // A branch keeps its parent's model and effort unless it was given its own.
        const settings = { model: model === undefined ? parent.model : model, effort: effort === undefined ? parent.effort : effort };
        if (model !== undefined || effort !== undefined) await checkModel(settings.model, settings.effort);
        branches.push({ prompt, title: title ?? titleFromPrompt(prompt), attachments: checked, ...settings });
      }
      if (runs.isRunning(parent.id)) throw conflict('Wait for the current reply to finish before forking.');
      // The parent stays open. Each branch inherits what it has now (its fork point) and forks its
      // session as it is now; the parent's next message continues in a copy (`planSession`).
      const forkPoint = repo.listMessages(parent.id).length;
      const children = repo.transaction(() =>
        branches.map(({ title, model, effort }) =>
          repo.createNode({ projectId: parent.projectId, title, parentIds: [parent.id], model, effort, forkPoint, forkSession: parent.sessionId }),
        ),
      );
      llm.release?.(parent.id); // its next message starts a new process on the copy
      if (parent.gitBranch) {
        // Queued before the children's copies are made: they start from the parent's files as they are now.
        worktrees
          .fork(project, parent.id, children.map((child) => child.id), `${parent.title}: forked`)
          .catch((err: unknown) => console.error(`[git] fork ${parent.id}:`, err));
      }
      children.forEach((child, i) => runs.start(child.id, branches[i].prompt, branches[i].attachments));
      return c.json(children, 201);
    })

    // Ask the model to draft this branch's result. Nothing is saved until the user approves it.
    .post('/:nodeId/result/draft', async (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (node.status !== 'open') throw conflict('Only open branches can be finished.');
      if (node.parentIds.length === 0) throw new HttpError(400, 'The root node has no result to merge.');
      if (runs.isRunning(node.id)) throw conflict('Wait for the current reply to finish.');
      const graph = repo.snapshot(node.projectId);
      if (!graph.messages(node.id).some((m) => m.role === 'assistant')) {
        throw new HttpError(400, 'This branch has no replies yet.');
      }

      const ctx: ReplyContext = {
        nodeId: node.id,
        workDir: workspaces.prepare(repo.getProject(node.projectId)!),
        request: buildChatRequest(graph, node.id, [{ role: 'user', content: DRAFT_RESULT_INSTRUCTION }]),
        message: DRAFT_RESULT_INSTRUCTION,
        session: planSession(graph, node.id),
        model: node.model,
        effort: node.effort,
        edit: null, // drafting runs without tools
        mcpUrl: null,
      };
      try {
        return c.json(await llm.draftResult(ctx, c.req.raw.signal));
      } catch (err) {
        console.error(`[draft] node ${node.id}:`, err);
        const error = classifyError(err);
        runs.noteFailure(error);
        // The dialog shows this and offers to write the result by hand.
        throw new HttpError(502, error.message);
      }
    })

    // Approve (or edit) the result. This finishes the branch.
    .put('/:nodeId/result', zValidator('json', branchResultSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (node.parentIds.length === 0) throw new HttpError(400, 'The root node has no result to merge.');
      if (runs.isRunning(node.id)) throw conflict('Wait for the current reply to finish.');

      repo.setResult(node.id, c.req.valid('json'));
      llm.release?.(node.id); // a finished branch receives no more messages
      retireCopy(node);
      return c.json(repo.getNode(node.id)!);
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

/** Where branches were forked off a node, grouped by fork point (merge nodes are not forks). */
function forksOf(children: DagNode[]): NodeDetail['forks'] {
  const byPoint = new Map<number, string[]>();
  for (const c of children) {
    if (c.parentIds.length !== 1 || c.forkPoint === null) continue;
    byPoint.set(c.forkPoint, [...(byPoint.get(c.forkPoint) ?? []), c.id]);
  }
  return [...byPoint].sort(([a], [b]) => a - b).map(([at, childIds]) => ({ at, childIds }));
}
