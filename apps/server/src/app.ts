import { Hono } from 'hono';
import type { Repository } from './db/repository.ts';
import type { LLMProvider } from './llm/index.ts';
import { HttpError } from './routes/errors.ts';
import { nodeRoutes } from './routes/nodes.ts';
import { projectRoutes } from './routes/projects.ts';

export interface AppDeps {
  repo: Repository;
  llm: LLMProvider;
}

// Dependencies are passed in, so tests can use an in-memory database and a fake model.
export function createApp(deps: AppDeps) {
  return new Hono()
    .basePath('/api')
    .onError((err, c) => {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: 'Something went wrong on the server' }, 500);
    })
    .get('/health', (c) => c.json({ ok: true, model: deps.llm.label }))
    .route('/projects', projectRoutes(deps))
    .route('/nodes', nodeRoutes(deps));
}

export type AppType = ReturnType<typeof createApp>;
