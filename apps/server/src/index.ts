import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { backupDatabase, dailyBackup } from './db/backup.ts';
import { backupDirOf, openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import { providerFromEnv } from './llm/index.ts';
import { Workspaces } from './workspace.ts';

// Own variable name: a generic PORT is often set by tools for the web dev server.
const port = Number(process.env.HARNESS_SERVER_PORT ?? 8787);
// Everything the app stores: the database and the default project folders.
const dataDir = path.resolve(process.env.HARNESS_DATA_DIR ?? path.join(import.meta.dirname, '../../../data'));
const dbFile = process.env.HARNESS_DB ?? path.join(dataDir, 'harness.db');

const db = openDatabase(dbFile); // backs up first if the schema needs migrating
const backupDir = backupDirOf(dbFile);
const daily = dailyBackup(db, backupDir);
if (daily) console.log(`daily backup: ${daily}`);
const backup = (label: string) => backupDatabase(db, backupDir, label);

const repo = new Repository(db);
// Until the projects sidebar exists, everything lives in one default project.
if (!repo.getProject('default')) repo.createProject('default', 'My research', 'Main thread');

const llm = providerFromEnv();
const workspaces = new Workspaces(dataDir);
const app = createApp({ repo, llm, workspaces, backup });

// Stop background model processes (Claude Code) together with the server.
process.on('exit', () => llm.dispose?.());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
  console.log(`database: ${dbFile} (backups in ${backupDir})`);
  console.log(`model: ${llm.label}`);
  console.log(`project folders: ${workspaces.folderOf(repo.getProject('default')!)} (default project)`);
});
