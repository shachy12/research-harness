import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, type RunningServer } from '../../server/src/server.ts';
import { DEFAULT_PORT, dataDir, loadEnvFiles } from './config.ts';
import { ensureElectron, startElectron } from './electron-runtime.ts';

/**
 * `npx research-harness`: runs the Harness server (the same code as the desktop app) and opens the
 * UI in the default browser. The built web UI sits next to this file, in the package's `web/` folder.
 * With `--app` it opens an Electron window instead (electron-main.ts, which runs the server itself).
 *
 * Settings: variables already set win, then `.env` in the current folder, then `.env` in the data folder.
 * Data (database, default project folders): HARNESS_DATA_DIR, else a per-user folder.
 */

const HELP = `research-harness: DAG-based LLM research chat

Usage: npx research-harness [--app] [--no-open] [--port <n>]

  --app        open a desktop window (Electron, downloaded on first use, about 100 MB)
               instead of a browser tab; the terminal is free afterwards
  --no-open    do not open the browser
  --port <n>   listen on this port (default ${DEFAULT_PORT}, or HARNESS_SERVER_PORT)

Data folder: ${dataDir()}  (HARNESS_DATA_DIR changes it)
Settings: a .env file in the data folder or the current folder (see .env.example in the repository).
`;

function openBrowser(url: string) {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // no browser (e.g. a server): the printed URL is enough
    child.unref();
  } catch {
    // same
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }
  const portFlag = args.indexOf('--port');
  const port = Number(portFlag >= 0 ? args[portFlag + 1] : (process.env.HARNESS_SERVER_PORT ?? DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a number from 0 to 65535');

  const data = dataDir();
  fs.mkdirSync(data, { recursive: true });
  loadEnvFiles(data);

  const webDir = path.resolve(import.meta.dirname, '../web');
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error(`The web UI is missing (${webDir}). Reinstall the package.`);

  if (args.includes('--app')) {
    const electron = ensureElectron(data);
    startElectron(electron, path.resolve(import.meta.dirname, 'electron-main.mjs'), {
      ...process.env,
      HARNESS_DATA_DIR: data,
      HARNESS_WEB_DIR: webDir,
      HARNESS_SERVER_PORT: String(port),
    });
    console.log('Harness is opening in its own window. Closing the window stops it.');
    return;
  }

  const options = { dataDir: data, dbFile: process.env.HARNESS_DB, hostname: '127.0.0.1', webDir };
  let server: RunningServer;
  try {
    server = await startServer({ ...options, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    console.log(`Port ${port} is taken (is Harness already running?); using a free one.`);
    server = await startServer({ ...options, port: 0 });
  }

  console.log(`Harness is running at ${server.url}`);
  console.log(`Data folder: ${data}`);
  console.log('Press Ctrl+C to stop.');
  if (!args.includes('--no-open')) openBrowser(server.url);

  // Stop background model processes (Claude Code) together with the server.
  process.on('exit', () => void server.close());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
}

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`research-harness needs Node 24 or newer (this is ${process.version}).`);
  process.exit(1);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
