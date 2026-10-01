import { Hono } from 'hono';

// All routes live under /api. Chained so the route types can later power a typed client (Hono RPC).
export const app = new Hono()
  .basePath('/api')
  .get('/health', (c) => c.json({ ok: true }));

export type AppType = typeof app;
