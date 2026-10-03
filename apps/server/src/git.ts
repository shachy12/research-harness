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
 * Settings for the commits Harness makes itself on its own branches: authored by "Harness" (the
 * model wrote the change, and it works without a configured git identity), never GPG-signed
 * (that would wait for a passphrase).
 */
export const HARNESS_COMMIT_ARGS = ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false'];

/** Our environment without git variables that would point git at another repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}

/** Run git in `cwd`; never throws for a non-zero exit (the caller decides), only if git is missing. */
export function runGit(cwd: string, args: string[], input?: string): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
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
    child.stdin?.end(input ?? '');
  });
}

/** Run git and return its output; throws with git's own message if it fails. */
export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const out = await runGit(cwd, args, input);
  if (out.code !== 0) {
    const detail = (out.stderr || out.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${detail}`);
  }
  return out.stdout;
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
