import { serve } from '@hono/node-server';
import { app } from './app.ts';

// Own variable name: a generic PORT is often set by tools for the web dev server.
const port = Number(process.env.HARNESS_SERVER_PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
