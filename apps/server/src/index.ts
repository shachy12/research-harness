import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import { providerFromEnv } from './llm/index.ts';

// Own variable name: a generic PORT is often set by tools for the web dev server.
const port = Number(process.env.HARNESS_SERVER_PORT ?? 8787);
const dbFile = process.env.HARNESS_DB ?? path.resolve(import.meta.dirname, '../../../data/harness.db');

const repo = new Repository(openDatabase(dbFile));
// Until the projects sidebar exists, everything lives in one default project.
if (!repo.getProject('default')) repo.createProject('default', 'My research', 'Main thread');

const llm = providerFromEnv();
const app = createApp({ repo, llm });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
  console.log(`database: ${dbFile}`);
  console.log(`model: ${llm.label}`);
});
