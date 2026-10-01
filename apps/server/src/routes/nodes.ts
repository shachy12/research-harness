import { zValidator } from '@hono/zod-validator';
import {
  type ChatStreamEvent,
  type NodeDetail,
  branchResultSchema,
  forkSchema,
  renameNodeSchema,
  sendMessageSchema,
} from '@harness/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppDeps } from '../app.ts';
import { inheritedItems } from '../dag/context.ts';
import { DRAFT_RESULT_INSTRUCTION, buildChatRequest } from '../dag/prompt.ts';
import { conflict, HttpError, notFound } from './errors.ts';

export function nodeRoutes({ repo, llm }: AppDeps) {
  // One reply at a time per node, so two streams can't interleave in the same conversation.
  const streaming = new Set<string>();

  const requireNode = (id: string) => {
    const node = repo.getNode(id);
    if (!node) throw notFound('Node');
    return node;
  };

  const requireOpen = (id: string) => {
    const node = requireNode(id);
    if (node.status === 'frozen') throw conflict('This node was forked, so it is frozen. Continue in one of its branches.');
    if (node.status === 'finished') throw conflict('This branch is finished.');
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
      });
    })

    .patch('/:nodeId', zValidator('json', renameNodeSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      repo.setTitle(node.id, c.req.valid('json').title);
      return c.json(repo.getNode(node.id)!);
    })

    // Send a user message and stream the assistant's reply as server-sent events (see ChatStreamEvent).
    .post('/:nodeId/messages', zValidator('json', sendMessageSchema), (c) => {
      const node = requireOpen(c.req.param('nodeId'));
      if (streaming.has(node.id)) throw conflict('A reply is already being generated for this node.');

      const userMessage = repo.addMessage(node.id, 'user', c.req.valid('json').content);
      const request = buildChatRequest(repo.snapshot(node.projectId), node.id);
      streaming.add(node.id);

      return streamSSE(c, async (stream) => {
        const send = (event: ChatStreamEvent) => stream.writeSSE({ data: JSON.stringify(event) });
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());

        let text = '';
        try {
          await send({ type: 'user', message: userMessage });
          for await (const event of llm.streamReply(request, abort.signal)) {
            if (event.type === 'thinking') {
              await send({ type: 'thinking' });
            } else {
              text += event.text;
              await send({ type: 'delta', text: event.text });
            }
          }
          const reply = repo.addMessage(node.id, 'assistant', text);
          await send({ type: 'done', message: reply });
        } catch (err) {
          // Keep whatever arrived before the failure, so the user doesn't lose it.
          if (text) repo.addMessage(node.id, 'assistant', text);
          if (!abort.signal.aborted) {
            console.error(`[chat] node ${node.id}:`, err);
            await send({ type: 'error', error: err instanceof Error ? err.message : 'The model request failed' });
          }
        } finally {
          streaming.delete(node.id);
        }
      });
    })

    // Create child branches. Forking freezes an open node so its history stays fixed.
    .post('/:nodeId/fork', zValidator('json', forkSchema), (c) => {
      const parent = requireNode(c.req.param('nodeId'));
      if (streaming.has(parent.id)) throw conflict('Wait for the current reply to finish before forking.');

      const children = repo.transaction(() => {
        if (parent.status === 'open') repo.setStatus(parent.id, 'frozen');
        return c.req.valid('json').titles.map((title) =>
          repo.createNode({ projectId: parent.projectId, title, parentIds: [parent.id] }),
        );
      });
      return c.json(children, 201);
    })

    // Ask the model to draft this branch's result. Nothing is saved until the user approves it.
    .post('/:nodeId/result/draft', async (c) => {
      const node = requireOpen(c.req.param('nodeId'));
      if (node.parentIds.length === 0) throw new HttpError(400, 'The root node has no result to merge.');
      const graph = repo.snapshot(node.projectId);
      if (!graph.messages(node.id).some((m) => m.role === 'assistant')) {
        throw new HttpError(400, 'This branch has no replies yet.');
      }

      const request = buildChatRequest(graph, node.id, [{ role: 'user', content: DRAFT_RESULT_INSTRUCTION }]);
      const draft = await llm.draftResult(request, c.req.raw.signal);
      return c.json(draft);
    })

    // Approve (or edit) the result. This finishes the branch.
    .put('/:nodeId/result', zValidator('json', branchResultSchema), (c) => {
      const node = requireNode(c.req.param('nodeId'));
      if (node.parentIds.length === 0) throw new HttpError(400, 'The root node has no result to merge.');
      if (node.status === 'frozen') throw conflict('This node was forked, so it can no longer be finished.');
      if (streaming.has(node.id)) throw conflict('Wait for the current reply to finish.');

      repo.setResult(node.id, c.req.valid('json'));
      return c.json(repo.getNode(node.id)!);
    });
}
