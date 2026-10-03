import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Handler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Serves the built web UI (the folder `vite build` makes) so one server gives both the page and
 * `/api`. Unknown paths get `index.html`, because the UI's routes (`/projects/:id/...`) are
 * handled in the browser. In development Vite serves the UI instead and this isn't used.
 */
export function staticFiles(webDir: string): Handler {
  const root = path.resolve(webDir);
  return async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.notFound();
    const requested = path.resolve(root, '.' + decodeURIComponent(new URL(c.req.url).pathname));
    // Never leave the web folder (`/../..`).
    const inside = requested === root || requested.startsWith(root + path.sep);
    const file = inside && (await isFile(requested)) ? requested : path.join(root, 'index.html');
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' };
    // Vite names built assets by content hash, so they never change; the page itself must be rechecked.
    headers['Cache-Control'] = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    try {
      return new Response(new Uint8Array(await readFile(file)), { headers });
    } catch {
      return c.text('The web UI is not built. Run `npm run build -w @harness/web`.', 404);
    }
  };
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
