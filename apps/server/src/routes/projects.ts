import { zValidator } from '@hono/zod-validator';
import { type GraphResponse, MAX_UPLOAD_BYTES, type NodeSummary, mergeSchema } from '@harness/shared';
import { Hono } from 'hono';
import type { RouteDeps } from '../app.ts';
import { conflict, HttpError, notFound } from './errors.ts';

export function projectRoutes({ repo, llm, runs, workspaces }: RouteDeps) {
  return new Hono()
    // Upload a file (multipart field "file"). It is copied into the project's .harness/uploads/ and
    // can then be attached to a message; the model reads it from there.
    .post('/:projectId/uploads', async (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw new HttpError(400, 'Send the file in a form field named "file"');
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `"${file.name}" is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      }
      const attachment = workspaces.saveUpload(project, file.name, new Uint8Array(await file.arrayBuffer()));
      return c.json(attachment, 201);
    })

    .get('/:projectId/graph', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');

      const graph = repo.snapshot(project.id);
      const nodes: NodeSummary[] = graph.allNodes().map((node) => {
        const last = graph.messages(node.id).at(-1);
        return {
          ...node,
          messageCount: graph.messages(node.id).length,
          lastMessage: last?.content ?? null,
          lastRole: last?.role ?? null,
          running: runs.isRunning(node.id),
        };
      });
      return c.json<GraphResponse>({ project, nodes });
    })

    // Create a merge node from finished branches and start it working on its first message.
    .post('/:projectId/merge', zValidator('json', mergeSchema), (c) => {
      const projectId = c.req.param('projectId');
      const { title, prompt } = c.req.valid('json');
      const parentIds = [...new Set(c.req.valid('json').parentIds)];
      if (parentIds.length < 2) throw new HttpError(400, 'Select at least two different branches');

      for (const id of parentIds) {
        const parent = repo.getNode(id);
        if (!parent || parent.projectId !== projectId) throw notFound(`Node ${id}`);
        if (parent.status !== 'finished') throw conflict(`"${parent.title}" is not finished yet`);
      }
      const node = repo.createNode({ projectId, title, parentIds });
      runs.start(node.id, prompt);
      return c.json(node, 201);
    })

    // Start over: delete all nodes and messages, keep the project with a fresh root.
    .post('/:projectId/reset', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      for (const node of repo.listNodes(project.id)) {
        runs.stop(node.id); // stop running replies
        llm.release?.(node.id); // and their model processes
      }
      const root = repo.resetProject(project.id, 'Main thread');
      return c.json(root);
    });
}
