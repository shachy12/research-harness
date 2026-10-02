import { zValidator } from '@hono/zod-validator';
import {
  type ChatStreamEvent,
  type NodeDetail,
  branchResultSchema,
  forkSchema,
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
import type { ReplyContext } from '../llm/index.ts';
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

export function nodeRoutes({ repo, llm, runs, workspaces }: RouteDeps) {
  const requireNode = (id: string) => {
    const node = repo.getNode(id);
    if (!node) throw notFound('Node');
    return node;
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
        running: runs.isRunning(node.id),
      });
    })

    .patch('/:nodeId', zValidator('json', renameNodeSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      repo.setTitle(node.id, c.req.valid('json').title);
      return c.json(repo.getNode(node.id)!);
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

    // Stop the running reply; what arrived so far is kept.
    .post('/:nodeId/stop', (c) => {
      runs.stop(requireNode(c.req.param('nodeId')).id);
      return c.json({ ok: true });
    })

    // Create branches, one per prompt, and start each one working on its prompt right away.
    // Forking freezes an open node so its history stays fixed.
    .post('/:nodeId/fork', zValidator('json', forkSchema), (c) => {
      const parent = requireNode(c.req.param('nodeId'));
      if (runs.isRunning(parent.id)) throw conflict('Wait for the current reply to finish before forking.');

      const { prompts } = c.req.valid('json');
      const children = repo.transaction(() => {
        if (parent.status === 'open') repo.setStatus(parent.id, 'frozen');
        return prompts.map((prompt) =>
          repo.createNode({ projectId: parent.projectId, title: titleFromPrompt(prompt), parentIds: [parent.id] }),
        );
      });
      llm.release?.(parent.id); // the parent receives no more messages
      children.forEach((child, i) => runs.start(child.id, prompts[i]));
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
      };
      try {
        return c.json(await llm.draftResult(ctx, c.req.raw.signal));
      } catch (err) {
        console.error(`[draft] node ${node.id}:`, err);
        // The dialog shows this and offers to write the result by hand.
        throw new HttpError(502, err instanceof Error ? err.message : 'Drafting the result failed');
      }
    })

    // Approve (or edit) the result. This finishes the branch.
    .put('/:nodeId/result', zValidator('json', branchResultSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (node.parentIds.length === 0) throw new HttpError(400, 'The root node has no result to merge.');
      if (node.status === 'frozen') throw conflict('This node was forked, so it can no longer be finished.');
      if (runs.isRunning(node.id)) throw conflict('Wait for the current reply to finish.');

      repo.setResult(node.id, c.req.valid('json'));
      llm.release?.(node.id); // a finished branch receives no more messages
      return c.json(repo.getNode(node.id)!);
    });
}
