// Bundles the Electron main process, with the Harness server inside it, into dist/main.mjs.
// `--web` also builds the web UI first (for packaging).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { build } from 'esbuild';

if (process.argv.includes('--web')) execSync('npm run build -w @harness/web', { stdio: 'inherit', cwd: '../..' });

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: ['electron'], // provided by Electron itself; node: built-ins (node:sqlite) are external by default
  // Some bundled packages are CommonJS and call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// The Python programs Harness runs in containers (the sandbox's MCP stub and egress proxy) are
// read at run time from container/ next to the bundle (see apps/server/src/sandbox/stub.ts).
fs.rmSync('dist/container', { recursive: true, force: true });
fs.cpSync('../server/src/sandbox/container', 'dist/container', { recursive: true });
