import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, type RunningServer } from '../../server/src/server.ts';
import packageJson from '../package.json' with { type: 'json' };
import { DEFAULT_PORT, dataDir } from './config.ts';
import { databaseName, versionDatabase } from './database-file.ts';
import { ensureElectron, startElectron } from './electron-runtime.ts';

/**
 * `npx research-harness`: runs the Harness server (the same code as the desktop app) and opens the
 * UI in the default browser. The built web UI sits next to this file, in the package's `web/` folder.
 * With `--app` it opens an Electron window instead (electron-main.ts, which runs the server itself).
 *
 * Data (database, default project folders): HARNESS_DATA_DIR, else a per-user folder. Each version
 * of the package has its own database file there (see `versionDatabase`).
 */

const HELP = `research-harness: DAG-based LLM research chat

Usage: npx research-harness [--app] [--no-open] [--port <n>]
       npx research-harness check-cache [<model>]

  --app        open a desktop window (Electron, downloaded on first use, about 100 MB)
               instead of a browser tab; the terminal is free afterwards
  --no-open    do not open the browser
  --port <n>   listen on this port (default ${DEFAULT_PORT}, or HARNESS_SERVER_PORT)
  check-cache  check that branches and resumed nodes still share the prompt cache, with your
               Claude Code setup (uses a little of your usage; default model claude-haiku-4-5,
               pass your own model id, e.g. a Bedrock one, as the argument)

Data folder: ${dataDir()}  (HARNESS_DATA_DIR changes it)
Database: ${databaseName(packageJson.version)} in the data folder; each version has its own, copied
          from the most recently used older one on its first start (HARNESS_DB changes it)
Settings are environment variables (a settings window will replace them):
  HARNESS_MODEL    default model for new nodes (default claude-sonnet-5-5); any id the Claude Code
                   CLI accepts, e.g. a Bedrock model or inference-profile id
  HARNESS_MODELS   more model ids to offer in the model pickers, comma-separated, e.g.
                   HARNESS_MODELS=us.anthropic.claude-sonnet-5-5-v1:0,us.anthropic.claude-haiku-4-5-v1:0
  HARNESS_EFFORT   default effort: low (default) | medium | high | xhigh | max
  HARNESS_CLAUDE_PATH  full path of the claude executable, if it is not found automatically
  Bedrock: CLAUDE_CODE_USE_BEDROCK=1 plus your AWS_REGION / AWS_PROFILE are passed to Claude Code.
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
  if (args[0] === 'check-cache') {
    // The check reads its model from argv[2]; it exits the process itself when done.
    process.argv.splice(2, 1);
    await import('../../server/src/scripts/check-cache.ts');
    return;
  }
  const portFlag = args.indexOf('--port');
  const port = Number(portFlag >= 0 ? args[portFlag + 1] : (process.env.HARNESS_SERVER_PORT ?? DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a number from 0 to 65535');

  const data = dataDir();
  fs.mkdirSync(data, { recursive: true });

  const webDir = path.resolve(import.meta.dirname, '../web');
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error(`The web UI is missing (${webDir}). Reinstall the package.`);
  const dbFile = process.env.HARNESS_DB ?? versionDatabase(data, packageJson.version);

  if (args.includes('--app')) {
    const electron = ensureElectron(data);
    startElectron(electron, path.resolve(import.meta.dirname, 'electron-main.mjs'), {
      ...process.env,
      HARNESS_DATA_DIR: data,
      HARNESS_DB: dbFile,
      HARNESS_WEB_DIR: webDir,
      HARNESS_SERVER_PORT: String(port),
    });
    console.log('Harness is opening in its own window. Closing the window stops it.');
    return;
  }

  const options = { dataDir: data, dbFile, hostname: '127.0.0.1', webDir };
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
  console.log(`Database: ${path.basename(dbFile)}`);
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
