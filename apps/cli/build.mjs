// Bundles the command line launcher and the Electron window's main file (each with the Harness
// server inside) into dist/, and copies the built web UI to web/. `--web` builds the web UI first
// (done by `npm pack` / `publish`).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { build } from 'esbuild';

if (process.argv.includes('--web')) execSync('npm run build -w @harness/web', { stdio: 'inherit', cwd: '../..' });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
};
// Some bundled packages are CommonJS and call require().
const requireShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";

// node: built-ins (node:sqlite) are external by default. The shebang makes it runnable as a bin.
await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs', banner: { js: `#!/usr/bin/env node\n${requireShim}` } });
// `electron` is provided by Electron itself.
await build({ ...common, entryPoints: ['src/electron-main.ts'], outfile: 'dist/electron-main.mjs', external: ['electron'], banner: { js: requireShim } });

const webDist = new URL('../web/dist/', import.meta.url);
if (!fs.existsSync(new URL('index.html', webDist))) {
  throw new Error('The web UI is not built. Run "npm run build -w @harness/web" or build with --web.');
}
fs.rmSync('web', { recursive: true, force: true });
fs.cpSync(webDist, 'web', { recursive: true });
