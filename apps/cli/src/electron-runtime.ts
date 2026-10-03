import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Keep equal to apps/desktop/package.json: the same Electron the app is tested with.
const ELECTRON_VERSION = '44.5.1';

/**
 * The Electron program for `--app`: HARNESS_ELECTRON_PATH, else a copy installed into the data
 * folder on first use (about 100 MB; Electron's own download, cached for later runs).
 * npm 12 doesn't run install scripts, so the package is installed without them and Electron's
 * download script (which fetches the binary) is run by hand.
 */
export function ensureElectron(data: string): string {
  if (process.env.HARNESS_ELECTRON_PATH) return process.env.HARNESS_ELECTRON_PATH;

  const dir = path.join(data, 'electron-runtime');
  const find = () => {
    try {
      const found = createRequire(path.join(dir, 'package.json'))('electron') as unknown;
      return typeof found === 'string' && fs.existsSync(found) ? found : null;
    } catch {
      return null; // not installed, or its binary was never downloaded
    }
  };
  const ready = find();
  if (ready) return ready;

  console.log(`Installing Electron ${ELECTRON_VERSION} into ${dir} (first run only, about 100 MB)…`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'research-harness-electron', private: true }));
  // `npm` is a .cmd file on Windows, which only a shell can start.
  const win = process.platform === 'win32';
  run(win ? 'npm.cmd' : 'npm', ['install', `electron@${ELECTRON_VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund'], dir, win);
  run(process.execPath, [path.join(dir, 'node_modules', 'electron', 'install.js')], dir, false);

  const installed = find();
  if (!installed) throw new Error(`Electron did not install into ${dir}. Delete that folder and try again.`);
  return installed;
}

function run(command: string, args: string[], cwd: string, shell: boolean) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell });
}

/** Starts Electron on the bundled main file, detached, so the terminal is free again. */
export function startElectron(electron: string, mainFile: string, env: NodeJS.ProcessEnv) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // set by some tools; it would make Electron behave as plain Node
  // The downloaded Electron has no setuid sandbox helper on Linux, so it can't start without this.
  const args = process.platform === 'linux' ? ['--no-sandbox', mainFile] : [mainFile];
  const child = spawn(electron, args, { stdio: 'ignore', detached: true, env: childEnv });
  child.on('error', (err) => console.error(`Could not start Electron: ${err.message}`));
  child.unref();
}
