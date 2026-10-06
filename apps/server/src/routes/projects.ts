import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  type FolderGit,
  type GraphResponse,
  type MergePreview,
  type ProjectSummary,
  createProjectSchema,
  checkFolderSchema,
  mergePreviewSchema,
  updateProjectSchema,
  MAX_FOLDER_BYTES,
  MAX_FOLDER_FILES,
  MAX_UPLOAD_BYTES,
  type NodeSummary,
  defaultMergeTitle,
  mergeModelSettings,
  mergeSchema,
  unreadCount,
} from '@harness/shared';
import { Hono } from 'hono';
import type { RouteDeps } from '../app.ts';
import { HttpError, notFound } from './errors.ts';

export function projectRoutes({ repo, llm, runs, workspaces, worktrees, backup, loadModels, checkModel }: RouteDeps) {
  return new Hono()
    .get('/', (c) =>
      c.json<ProjectSummary[]>(
        repo.listProjects().map((p) => ({
          ...p,
          running: repo.listNodes(p.id).some((n) => runs.isBusy(n.id)),
        })),
      ),
    )

    // A new project starts with an empty root node. Its folder is fixed from now on.
    .post('/', zValidator('json', createProjectSchema), async (c) => {
      const { name, folder, model = null, effort = null } = c.req.valid('json');
      await checkModel(model, effort);
      let chosen: string;
      if (folder) {
        const checked = workspaces.checkFolder(folder);
        if (typeof checked !== 'string') throw new HttpError(400, checked.error);
        chosen = checked;
      } else {
        chosen = workspaces.newFolder(name); // named after the project
      }
      const project = repo.createProject(randomUUID(), name, 'Main thread', chosen);
      // The root's setting plays the project default's role: branches copy it.
      if (model !== null || effort !== null) repo.setModelSettings(repo.listNodes(project.id)[0].id, model, effort);
      workspaces.prepare(project);
      // Nodes edit their own git copies of the folder, so it must be a repository (the dialog said so).
      try {
        await worktrees.setUp(project);
      } catch (err) {
        console.error(`[git] set up ${project.id}:`, err); // retried at the first run
      }
      return c.json(project, 201);
    })

    // The folder a project with this name would get if no folder is chosen (the new-project dialog shows it).
    .get('/new-folder', (c) => c.json({ path: workspaces.newFolderPath(c.req.query('name')?.trim() || 'New project') }))

    // What creating a project on this folder does in git (the new-project dialog shows it first).
    .post('/check-folder', zValidator('json', checkFolderSchema), async (c) => {
      const checked = workspaces.checkFolder(c.req.valid('json').folder);
      if (typeof checked !== 'string') throw new HttpError(400, checked.error);
      return c.json<FolderGit>(await worktrees.inspect(checked));
    })

    .patch('/:projectId', zValidator('json', updateProjectSchema), (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      const { name, archived } = c.req.valid('json');
      if (name !== undefined) repo.setProjectName(project.id, name);
      if (archived !== undefined) repo.setProjectArchived(project.id, archived);
      return c.json(repo.getProject(project.id)!);
    })

    // Delete a project: its nodes, messages and results. A backup of the database is made first (if
    // that fails, nothing is deleted). The project's folder, uploads and git branches stay on disk.
    .delete('/:projectId', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      try {
        const saved = backup?.('before-delete-project');
        if (saved) console.log(`database backed up before deleting project "${project.name}": ${saved}`);
      } catch (err) {
        console.error('[delete project] backup failed:', err);
        throw new HttpError(500, 'Could not back up the database, so nothing was deleted.');
      }
      for (const node of repo.listNodes(project.id)) {
        runs.stop(node.id);
        llm.release?.(node.id);
      }
      repo.deleteProject(project.id);
      return c.json({ ok: true });
    })

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

    // Upload a whole folder in one request: field "name" (the folder's name), then pairs of "path"
    // (relative to the folder, e.g. "figures/plot.png") and "file", in the same order.
    .post('/:projectId/uploads/folder', async (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      const body = await c.req.parseBody({ all: true });
      const name = typeof body.name === 'string' ? body.name : '';
      const paths = [body.path ?? []].flat();
      const files = [body.file ?? []].flat();
      if (!name || files.length === 0 || files.length !== paths.length) {
        throw new HttpError(400, 'Send the folder name, then a "path" and a "file" field for each file');
      }
      if (files.length > MAX_FOLDER_FILES) throw new HttpError(413, `"${name}" has more than ${MAX_FOLDER_FILES} files`);

      const entries: { path: string; bytes: Uint8Array }[] = [];
      let total = 0;
      for (const [i, file] of files.entries()) {
        const rel = paths[i];
        if (!(file instanceof File) || typeof rel !== 'string') throw new HttpError(400, 'Each "path" must be followed by its file');
        total += file.size;
        if (total > MAX_FOLDER_BYTES) {
          throw new HttpError(413, `"${name}" is larger than ${MAX_FOLDER_BYTES / 1024 / 1024} MB`);
        }
        entries.push({ path: rel, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      return c.json(workspaces.saveFolder(project, name, entries), 201);
    })

    .get('/:projectId/graph', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');

      const graph = repo.snapshot(project.id);
      const nodes: NodeSummary[] = graph.allNodes().map((node) => {
        const messages = graph.messages(node.id);
        const last = messages.at(-1);
        const lastReply = messages.findLastIndex((m) => m.role === 'assistant');
        // A fork after that reply (a branch whose fork point includes it) dealt with its proposal.
        const forkPoints = graph.children(node.id).flatMap((c) => (c.forkPoint === null ? [] : [c.forkPoint]));
        const forkedSince = forkPoints.some((at) => at > lastReply);
        return {
          ...node,
          messageCount: messages.length,
          lastMessage: last?.content ?? null,
          lastRole: last?.role ?? null,
          unread: unreadCount(messages, node.readUpto),
          running: runs.isRunning(node.id),
          run: runs.status(node.id),
          titlePending: runs.isTitling(node.id),
          // Branches the model proposed in its last reply, while the user can still start them.
          proposedBranches: node.status === 'open' && lastReply >= 0 && !forkedSince
            ? (messages[lastReply].forkProposal?.branches.length ?? 0)
            : 0,
          forkedAtEnd: forkPoints.includes(messages.length),
          merge: runs.mergeState(node, messages.length),
        };
      });
      return c.json<GraphResponse>({ project, nodes, usage: runs.usage() });
    })

    // What merging these branches does to their files: changed files and conflicts (nothing is changed).
    .post('/:projectId/merge/preview', zValidator('json', mergePreviewSchema), async (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      const graph = repo.snapshot(project.id);
      const parentIds = [...new Set(c.req.valid('json').parentIds)];
      for (const id of parentIds) if (repo.getNode(id)?.projectId !== project.id) throw notFound(`Node ${id}`);
      if (!parentIds.some((id) => repo.getNode(id)?.gitBranch)) return c.json<MergePreview>({ branches: [], conflicts: [] });
      return c.json<MergePreview>(await worktrees.previewMerge(project, graph, parentIds));
    })

    // Merge any nodes: the merge node is created right away; it drafts each node's result in the
    // background (RunManager.startMerge), then starts working on its first message.
    .post('/:projectId/merge', zValidator('json', mergeSchema), async (c) => {
      const projectId = c.req.param('projectId');
      const { title, prompt, model, effort } = c.req.valid('json');
      const parentIds = [...new Set(c.req.valid('json').parentIds)];
      if (parentIds.length < 2) throw new HttpError(400, 'Select at least two different nodes');

      const parents = parentIds.map((id) => {
        const parent = repo.getNode(id);
        if (!parent || parent.projectId !== projectId) throw notFound(`Node ${id}`);
        return parent;
      });
      // The model and effort chosen in the merge dialog; left out, the branches' setting, or if they
      // differ, the model first by name (the dialog warns about it).
      const catalog = await loadModels();
      const { mixedModels: _mixed, ...rule } = mergeModelSettings(parents, { model: catalog.defaultModel, effort: catalog.defaultEffort });
      const settings = { model: model === undefined ? rule.model : model, effort: effort === undefined ? rule.effort : effort };
      if (model !== undefined || effort !== undefined) await checkModel(settings.model, settings.effort);
      // A title the user wrote is final; the default one may be replaced by a model-written title.
      const node = title
        ? repo.createNode({ projectId, title, parentIds, titleSource: 'user', mergePrompt: prompt, ...settings })
        : repo.createNode({ projectId, title: defaultMergeTitle(parents.map((p) => p.title)), parentIds, mergePrompt: prompt, ...settings });
      runs.startMerge(node.id);
      return c.json(node, 201);
    })

    // Another root in the project: an empty node with no parents, sharing the project's folder but
    // no context. It takes the first root's model and effort (the project's default, in effect).
    .post('/:projectId/roots', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      const first = repo.listNodes(project.id).find((n) => n.parentIds.length === 0);
      const root = repo.createNode({ projectId: project.id, title: 'New thread', parentIds: [], model: first?.model ?? null, effort: first?.effort ?? null });
      return c.json(root, 201);
    })

    // Start over: delete all nodes and messages, keep the project with a fresh root.
    .post('/:projectId/reset', (c) => {
      const project = repo.getProject(c.req.param('projectId'));
      if (!project) throw notFound('Project');
      // Keep a copy of everything first; if that fails, delete nothing.
      try {
        const saved = backup?.('before-reset');
        if (saved) console.log(`database backed up before reset: ${saved}`);
      } catch (err) {
        console.error('[reset] backup failed:', err);
        throw new HttpError(500, 'Could not back up the database, so nothing was deleted.');
      }
      for (const node of repo.listNodes(project.id)) {
        runs.stop(node.id); // stop running replies
        llm.release?.(node.id); // and their model processes
      }
      const root = repo.resetProject(project.id, 'Main thread');
      return c.json(root);
    });
}
