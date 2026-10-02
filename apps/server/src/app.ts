import { Hono } from 'hono';
import type { Repository } from './db/repository.ts';
import type { LLMProvider } from './llm/index.ts';
import { HttpError } from './routes/errors.ts';
import { nodeRoutes } from './routes/nodes.ts';
import { projectRoutes } from './routes/projects.ts';
import { RunManager } from './runs.ts';
import type { Workspaces } from './workspace.ts';

export interface AppDeps {
  repo: Repository;
  llm: LLMProvider;
  workspaces: Workspaces;
  /** Back up the database (e.g. before "Start over"); returns the backup's path. Absent in tests. */
  backup?: (label: string) => string;
}

export interface RouteDeps extends AppDeps {
  runs: RunManager;
}

// Dependencies are passed in, so tests can use an in-memory database and a fake model.
export function createApp(deps: AppDeps) {
  const routeDeps: RouteDeps = { ...deps, runs: new RunManager(deps.repo, deps.llm, deps.workspaces) };
  return new Hono()
    .basePath('/api')
    .onError((err, c) => {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: 'Something went wrong on the server' }, 500);
    })
    .get('/health', (c) => c.json({ ok: true, model: deps.llm.label }))
    .route('/projects', projectRoutes(routeDeps))
    .route('/nodes', nodeRoutes(routeDeps));
}

export type AppType = ReturnType<typeof createApp>;
