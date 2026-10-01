import { zValidator } from '@hono/zod-validator';
import { type GraphResponse, type NodeSummary, mergeSchema } from '@harness/shared';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { conflict, HttpError, notFound } from './errors.ts';

export function projectRoutes({ repo, llm }: AppDeps) {
  return new Hono()
    .get('/:projectId/graph', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');

      const graph = repo.snapshot(project.id);
      const nodes: NodeSummary[] = graph.allNodes().map((node) => {
        const messages = graph.messages(node.id);
        return { ...node, messageCount: messages.length, lastMessage: messages.at(-1)?.content ?? null };
      });
      return c.json<GraphResponse>({ project, nodes });
    })

    // Create a merge node from finished branches. The client then sends the framing prompt as its first message.
    .post('/:projectId/merge', zValidator('json', mergeSchema), (c) => {
      const projectId = c.req.param('projectId');
      const { title } = c.req.valid('json');
      const parentIds = [...new Set(c.req.valid('json').parentIds)];
      if (parentIds.length < 2) throw new HttpError(400, 'Select at least two different branches');

      for (const id of parentIds) {
        const parent = repo.getNode(id);
        if (!parent || parent.projectId !== projectId) throw notFound(`Node ${id}`);
        if (parent.status !== 'finished') throw conflict(`"${parent.title}" is not finished yet`);
      }
      const node = repo.createNode({ projectId, title, parentIds });
      return c.json(node, 201);
    })

    // Start over: delete all nodes and messages, keep the project with a fresh root.
    .post('/:projectId/reset', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      for (const node of repo.listNodes(project.id)) llm.release?.(node.id); // stop running model processes
      const root = repo.resetProject(project.id, 'Main thread');
      return c.json(root);
    });
}
