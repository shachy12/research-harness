import path from 'node:path';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp } from './app.ts';
import { backupDatabase, dailyBackup } from './db/backup.ts';
import { backupDirOf, openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import { providerFromEnv } from './llm/index.ts';
import { DEFAULT_ASK_LIMIT } from './runs.ts';
import { staticFiles } from './static.ts';
import type { pickFolder as PickFolder } from './system/folder-picker.ts';
import { Workspaces } from './workspace.ts';

export interface ServerOptions {
  /** Everything the app stores: the database and the default project folders. */
  dataDir: string;
  /** 0 picks a free port. */
  port: number;
  /** Interface to listen on; omit for all. The desktop app only listens on the loopback address. */
  hostname?: string;
  /** Database file (default: harness.db in `dataDir`). */
  dbFile?: string;
  /** A built web UI to serve next to `/api` (the desktop app); without it, Vite serves the UI. */
  webDir?: string;
  /** Show a folder dialog (default: the OS's own, through a helper process; Electron passes its own). */
  pickFolder?: typeof PickFolder;
}

export interface RunningServer {
  port: number;
  url: string;
  dbFile: string;
  /** Stops listening and the model processes. */
  close(): Promise<void>;
}

/** Opens the database, creates the app and starts listening. Used by `index.ts` and the Electron app. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const dataDir = path.resolve(options.dataDir);
  const dbFile = options.dbFile ?? path.join(dataDir, 'harness.db');

  const db = openDatabase(dbFile); // backs up first if the schema needs migrating
  const backupDir = backupDirOf(dbFile);
  const daily = dailyBackup(db, backupDir);
  if (daily) console.log(`daily backup: ${daily}`);
  const backup = (label: string) => backupDatabase(db, backupDir, label);

  const repo = new Repository(db);
  // A first start gets one project to begin with; more are created from the sidebar.
  if (repo.listProjects().length === 0) repo.createProject('default', 'My research', 'Main thread');

  const llm = providerFromEnv();
  const workspaces = new Workspaces(dataDir);
  // ask_node questions one user message allows before the user must approve more (until a settings page exists).
  const askLimit = Number(process.env.HARNESS_ASK_LIMIT ?? DEFAULT_ASK_LIMIT);
  if (!Number.isInteger(askLimit) || askLimit < 0) throw new Error('HARNESS_ASK_LIMIT must be a whole number, 0 or more');

  // The port may be chosen by the OS, and the model's CLI needs to know it for the harness MCP
  // server, so the URL is read from the server once it listens.
  const state = { url: '' };
  const api = createApp({
    repo,
    llm,
    workspaces,
    backup,
    get serverUrl() {
      return state.url;
    },
    askLimit,
    pickFolder: options.pickFolder,
  });
  let app: Hono = api;
  if (options.webDir) {
    app = new Hono().route('/', api);
    app.get('*', staticFiles(options.webDir));
  }

  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, () => resolve(s));
    s.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  state.url = `http://127.0.0.1:${port}`;

  console.log(`server listening on ${state.url}`);
  console.log(`database: ${dbFile} (backups in ${backupDir})`);
  console.log(`model: ${llm.label}`);
  console.log(`projects: ${repo.listProjects().map((p) => `${p.name} (${workspaces.folderOf(p)})`).join(', ')}`);

  return {
    port,
    url: state.url,
    dbFile,
    close: async () => {
      llm.dispose?.();
      if ('closeAllConnections' in server) server.closeAllConnections(); // open event streams would keep it alive
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

