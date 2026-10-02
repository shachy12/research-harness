import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import { providerFromEnv } from './llm/index.ts';
import { Workspaces } from './workspace.ts';

// Own variable name: a generic PORT is often set by tools for the web dev server.
const port = Number(process.env.HARNESS_SERVER_PORT ?? 8787);
// Everything the app stores: the database and the default project folders.
const dataDir = path.resolve(process.env.HARNESS_DATA_DIR ?? path.join(import.meta.dirname, '../../../data'));
const dbFile = process.env.HARNESS_DB ?? path.join(dataDir, 'harness.db');

const repo = new Repository(openDatabase(dbFile));
// Until the projects sidebar exists, everything lives in one default project.
if (!repo.getProject('default')) repo.createProject('default', 'My research', 'Main thread');

const llm = providerFromEnv();
const workspaces = new Workspaces(dataDir);
const app = createApp({ repo, llm, workspaces });

// Stop background model processes (Claude Code) together with the server.
process.on('exit', () => llm.dispose?.());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
  console.log(`database: ${dbFile}`);
  console.log(`model: ${llm.label}`);
  console.log(`project folders: ${workspaces.folderOf(repo.getProject('default')!)} (default project)`);
});
