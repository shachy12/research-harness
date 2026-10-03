// Starts Electron against the running Vite dev server (hot reload); run through `npm run desktop:dev`.
import { spawn } from 'node:child_process';
import electron from 'electron';

const url = process.env.HARNESS_DEV_URL ?? `http://localhost:${process.env.HARNESS_WEB_PORT ?? 5173}`;

// Vite starts at the same time; wait until it answers.
for (let i = 0; ; i++) {
  try {
    await fetch(url);
    break;
  } catch {
    if (i > 60) throw new Error(`The Vite dev server did not start at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, HARNESS_DEV_URL: url } });
child.on('exit', (code) => process.exit(code ?? 0));
