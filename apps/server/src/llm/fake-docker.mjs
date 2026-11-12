// A stand-in for `docker`, used by sandbox.test.ts. `docker run …` is translated back to this
// machine (container paths through the --mount list) and runs the fake CLI (fake-claude.mjs)
// with the CLI's arguments. Before that it writes the session the CLI will report into the
// container's Claude folder, as the real CLI would, so copying it back can be tested. Each run's
// arguments, the variables the container got and whether the copied-in session was there go to
// the file in FAKE_DOCKER_LOG. Other commands (`rm -f`, …) succeed and do nothing.
import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'run') process.exit(0);

const withValue = new Set(['--name', '--label', '--user', '-w', '--mount', '-e', '--network', '--security-opt', '--cap-drop']);
const mounts = [];
const env = {};
let workDir = '/';
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('-')) break;
  if (!withValue.has(a)) continue;
  const value = args[++i];
  if (a === '-w') workDir = value;
  if (a === '--mount') {
    const fields = Object.fromEntries(value.split(',').map((f) => f.replace(/^"|"$/g, '').split('=')));
    mounts.push({ source: fields.source, target: fields.target });
  }
  if (a === '-e') {
    const eq = value.indexOf('=');
    if (eq === -1) env[value] = process.env[value];
    else env[value.slice(0, eq)] = value.slice(eq + 1);
  }
}
const image = args[i];
const cliArgs = args.slice(i + 2); // past the image and `claude`

/** A container path back on this machine, through the longest matching mount. */
const toHost = (p) => {
  const m = mounts.filter((x) => p === x.target || p.startsWith(`${x.target}/`)).sort((a, b) => b.target.length - a.target.length)[0];
  return m ? path.join(m.source, p.slice(m.target.length)) : p;
};

const flag = (name) => (cliArgs.includes(name) ? cliArgs[cliArgs.indexOf(name) + 1] : undefined);
const claudeDir = toHost(env.CLAUDE_CONFIG_DIR ?? '/home/harness/.claude');
const sessions = path.join(claudeDir, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
const resume = flag('--resume');
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({
  args, image, cliArgs, env, workDir,
  sessionIn: resume ? existsSync(path.join(sessions, `${resume}.jsonl`)) : null,
}) + '\n');

// The session the fake CLI will report (see fake-claude.mjs), written as the real CLI would.
const uuid = (tag) => `00000000-0000-4000-8000-${Buffer.from(tag).toString('hex').slice(0, 12).padStart(12, '0')}`;
const sessionId = resume ? (cliArgs.includes('--fork-session') ? uuid(`f${resume}`) : resume) : uuid('new');
mkdirSync(sessions, { recursive: true });
writeFileSync(path.join(sessions, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', from: 'sandbox' })}\n`);

const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fake-claude.mjs'), ...cliArgs], {
  cwd: toHost(workDir),
  env: { ...process.env, ...env },
  stdio: 'inherit',
});
child.on('close', (code) => process.exit(code ?? 1));
