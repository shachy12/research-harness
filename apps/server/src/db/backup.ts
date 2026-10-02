import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Database backups: consistent copies made with SQLite's `VACUUM INTO` (safe while the app is
 * running). The database is small, so copies are cheap.
 *
 *   harness-<date>-<time>-before-migration-v5.db   before the schema changes; kept forever
 *   harness-<date>-<time>-before-reset.db          before "Start over"; kept forever
 *   harness-<date>-<time>-daily.db                 once a day at startup; the newest 14 are kept
 *   harness-<date>-<time>-manual.db                made by hand; kept forever
 */
export const KEEP_DAILY = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Write a backup into `dir` and return its path. */
export function backupDatabase(db: DatabaseSync, dir: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `harness-${timestamp(new Date())}-${label}.db`);
  for (let i = 2; exists(target); i++) target = path.join(dir, `harness-${timestamp(new Date())}-${label}-${i}.db`);
  // VACUUM INTO needs a SQL string literal; forward slashes avoid escaping issues on Windows.
  db.exec(`VACUUM INTO '${target.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  return target;
}

/** A daily backup, if the newest backup of any kind is more than a day old. Also prunes old daily ones. */
export function dailyBackup(db: DatabaseSync, dir: string, now = Date.now()): string | null {
  const newest = listBackups(dir)[0];
  const made = !newest || now - newest.time > DAY_MS ? backupDatabase(db, dir, 'daily') : null;
  pruneDailyBackups(dir);
  return made;
}

/** Delete daily backups beyond the newest `keep`; other kinds are never deleted. */
export function pruneDailyBackups(dir: string, keep = KEEP_DAILY): void {
  const daily = listBackups(dir).filter((b) => b.name.endsWith('-daily.db'));
  for (const old of daily.slice(keep)) rmSync(path.join(dir, old.name));
}

/** Backups in `dir`, newest first. */
export function listBackups(dir: string): { name: string; time: number }[] {
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith('harness-') && name.endsWith('.db'))
    .map((name) => ({ name, time: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

/** Local time, sortable: 20261002-101530 */
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
