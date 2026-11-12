import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SESSION_ID, sessionFolderName } from './paths.ts';

/**
 * Claude Code sessions cross the sandbox's wall by copy, never by a shared folder: the folder with
 * the project's sessions holds every node's conversation (and the host CLI reads what is there),
 * so a sandbox gets only the one session it continues, and only that session comes back.
 */

/** Claude Code's own folder on this machine (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function hostClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

/** Sessions are at most this big when they come back (a long research conversation is a few MB). */
const MAX_SESSION_BYTES = 512 * 1024 * 1024;

/**
 * The folder holding the sessions of runs in `workDir`. Names longer than 200 characters are
 * shortened by the CLI in a way we don't reproduce; an existing folder starting the same is used.
 */
export function sessionDir(claudeDir: string, workDir: string): string {
  const name = sessionFolderName(workDir);
  const projects = path.join(claudeDir, 'projects');
  if (name.length <= 200) return path.join(projects, name);
  const prefix = name.slice(0, 200);
  const existing = existsSync(projects) ? readdirSync(projects).find((d) => d.startsWith(prefix)) : undefined;
  return path.join(projects, existing ?? name);
}

/** Where session `id` is: in the working folder's session folder, else any project's. */
export function findSession(claudeDir: string, workDir: string, id: string): string | null {
  if (!SESSION_ID.test(id)) return null;
  const direct = path.join(sessionDir(claudeDir, workDir), `${id}.jsonl`);
  if (existsSync(direct)) return direct;
  const projects = path.join(claudeDir, 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Copy session `id` from this machine into a sandbox's Claude folder, where the CLI running in
 * `containerWorkDir` looks for it. Its folder of large tool outputs comes along if there is one.
 * Returns whether the session was found.
 */
export function copySessionIn(id: string, from: { claudeDir: string; workDir: string }, to: { claudeDir: string; workDir: string }): boolean {
  const source = findSession(from.claudeDir, from.workDir, id);
  if (!source) return false;
  const target = path.join(to.claudeDir, 'projects', sessionFolderName(to.workDir));
  mkdirSync(target, { recursive: true });
  cpSync(source, path.join(target, `${id}.jsonl`));
  const extras = source.slice(0, -'.jsonl'.length);
  if (existsSync(extras) && statSync(extras).isDirectory()) cpSync(extras, path.join(target, id), { recursive: true });
  return true;
}

/**
 * Copy session `id` back from a sandbox's Claude folder to this machine's, after checking it is
 * what a session file looks like (JSON lines, a sane size). Only the conversation itself comes
 * back. Returns whether it was copied.
 */
export function copySessionBack(id: string, from: { claudeDir: string; workDir: string }, to: { claudeDir: string; workDir: string }): boolean {
  if (!SESSION_ID.test(id)) return false;
  let source = path.join(from.claudeDir, 'projects', sessionFolderName(from.workDir), `${id}.jsonl`);
  if (!existsSync(source)) {
    const found = findSession(from.claudeDir, from.workDir, id);
    if (!found) return false;
    source = found;
  }
  const stat = statSync(source);
  if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) return false;
  const text = readFileSync(source, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    } catch {
      return false;
    }
  }
  const dir = sessionDir(to.claudeDir, to.workDir);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.jsonl`);
  const temp = `${target}.harness-${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, target);
  return true;
}
