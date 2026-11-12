import path from 'node:path';

/**
 * Where a folder of the user's machine appears inside the sandbox (a Linux container). On Linux
 * and macOS at the same path; on Windows `C:\Users\x` becomes `/c/Users/x` (the form Git Bash and
 * Claude Code's permission rules use too). The structure stays the same, so relative paths (and
 * git's relative links between a worktree and its repository) still work.
 */
export function containerPath(hostPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.posix.normalize(hostPath);
  const resolved = path.win32.resolve(hostPath);
  const drive = /^([A-Za-z]):\\?(.*)$/.exec(resolved);
  if (!drive) throw new Error(`The sandbox can't use this folder (only folders on a drive letter work): ${hostPath}`);
  const rest = drive[2].split('\\').filter(Boolean).join('/');
  return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Is `child` the folder `parent` or inside it (compared the way the OS does)? */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * The folder name Claude Code keeps a working folder's sessions under (`~/.claude/projects/<name>`):
 * the path with every character that isn't a letter or digit replaced by `-`.
 */
export function sessionFolderName(workDir: string): string {
  return workDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A `--mount` value; fields with commas or quotes are quoted the CSV way, as Docker expects. */
export function mountSpec(m: { source: string; target: string; readonly: boolean }): string {
  const field = (key: string, value: string) => {
    const text = `${key}=${value}`;
    return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [field('type', 'bind'), field('source', m.source), field('target', m.target), ...(m.readonly ? ['readonly'] : [])].join(',');
}

/** A Claude Code session id: a UUID. Anything else from a sandbox is refused (it ends up in command lines). */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
