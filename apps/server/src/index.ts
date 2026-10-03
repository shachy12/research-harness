import path from 'node:path';
import { startServer } from './server.ts';

// Own variable name: a generic PORT is often set by tools for the web dev server.
const port = Number(process.env.HARNESS_SERVER_PORT ?? 8787);
const dataDir = path.resolve(process.env.HARNESS_DATA_DIR ?? path.join(import.meta.dirname, '../../../data'));

const server = await startServer({ dataDir, port, dbFile: process.env.HARNESS_DB });

// Stop background model processes (Claude Code) together with the server.
process.on('exit', () => void server.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
