import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * On macOS and Linux, an app started from the Dock, Finder or a desktop launcher gets a minimal PATH
 * (`/usr/bin:/bin:…`), not the one your shell sets up in ~/.zshrc / ~/.bashrc / ~/.profile. So the
 * model CLI in ~/.local/bin, Homebrew tools, or MacTeX's latexmk (which the model may run through
 * Bash) would not be found. This asks your login shell for its PATH and puts it in front of ours,
 * like VS Code and the `fix-path` package do. Windows apps get the full PATH already.
 */
export function useLoginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    // -i reads the interactive startup files (where most people set PATH), -l the login ones.
    // The markers separate PATH from anything the startup files print themselves.
    const out = execFileSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' }, // oh-my-zsh: don't stop to ask about updates
    });
    const shellPath = pathFromShellOutput(out);
    if (shellPath) env.PATH = mergePaths(shellPath, env.PATH);
  } catch (err) {
    // A slow or broken shell setup must not stop the app; HARNESS_CLAUDE_PATH still works.
    console.warn('Could not read PATH from the login shell:', err instanceof Error ? err.message : err);
  }
}

const MARK = '__HARNESS_PATH__';

/** The PATH between the markers, or null if the output doesn't have them. */
export function pathFromShellOutput(out: string): string | null {
  const match = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(out);
  return match?.[1].trim() || null;
}

/** The shell's entries first, then ours that it lacks; no duplicates, no empty entries. */
export function mergePaths(first: string, second: string | undefined): string {
  const entries = [...first.split(path.delimiter), ...(second ?? '').split(path.delimiter)].filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
}
