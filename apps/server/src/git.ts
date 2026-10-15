import { execFile } from 'node:child_process';

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Settings for every git command we run: long paths on Windows (worktrees sit a few folders deep),
 * and no prompts for credentials.
 */
const BASE_ARGS = ['-c', 'core.longpaths=true'];

/**
 * The identity for commits in `cwd`: the user's own `user.name` / `user.email` (global or the
 * repository's config) where set, "Harness" / `harness@localhost` for whatever is missing, so a
 * commit never fails for want of an identity.
 */
export async function identityArgs(cwd: string): Promise<string[]> {
  const out = await runGit(cwd, ['config', '--get-regexp', '^user\\.(name|email)$']);
  const set = new Set(out.stdout.split('\n').map((line) => line.split(' ', 1)[0].toLowerCase()));
  return [
    ...(set.has('user.name') ? [] : ['-c', 'user.name=Harness']),
    ...(set.has('user.email') ? [] : ['-c', 'user.email=harness@localhost']),
  ];
}

/**
 * Settings for the commits Harness makes itself on its own branches: the user's identity (see
 * `identityArgs`), never GPG-signed (that would wait for a passphrase).
 */
export async function commitArgs(cwd: string): Promise<string[]> {
  return [...(await identityArgs(cwd)), '-c', 'commit.gpgsign=false'];
}

/**
 * Our environment without git variables that would point git at another repository, plus the
 * caller's own (e.g. a temporary `GIT_INDEX_FILE`).
 */
function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return { ...env, ...extra };
}

/** Run git in `cwd`; never throws for a non-zero exit (the caller decides), only if git is missing. */
export function runGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, env: gitEnv(env), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          reject((err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error('Git is not installed (or not on PATH). File editing needs git.')
            : err);
          return;
        }
        resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
      },
    );
    // git may exit without reading its input; on Linux and macOS writing then fails with EPIPE,
    // which would crash the server unhandled. The exit code above reports what went wrong.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** Run git and return its output; throws with git's own message if it fails. */
export async function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  const out = await runGit(cwd, args, input, env);
  if (out.code !== 0) {
    const detail = (out.stderr || out.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${detail}`);
  }
  return out.stdout;
}

/** Run git and return its raw output (file contents, which may be binary); throws if it fails. */
export function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr.toString().trim() || err.message}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

/** Run tasks one at a time per key (one repository): git locks its index and refs. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
