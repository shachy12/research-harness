import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Versions up to 0.2.1 used this name; it counts as older than every versioned file. */
const LEGACY = 'harness.db';
const VERSIONED = /^harness-v(\d+)\.(\d+)\.(\d+)\.db$/;

export const databaseName = (version: string) => `harness-v${version}.db`;

/**
 * The database this version of the package works on: its own file, `harness-v<version>.db` in the
 * data folder. So after an upgrade an older version still works on its own file, as it left it
 * (`npx research-harness@0.2.1`).
 *
 * A version's first start copies the most recently used database of the same or an older version
 * (never a newer one: an older version can't read a newer schema) into its own file; the server
 * then migrates the copy. The original is only read. Nothing is ever deleted.
 */
export function versionDatabase(dataDir: string, version: string): string {
  const own = path.join(dataDir, databaseName(version));
  if (fs.existsSync(own)) return own;

  const source = latestUsable(dataDir, version);
  if (!source) return own; // a first start: the server creates it
  // Copy under a temporary name, so a copy cut short is never taken for this version's database.
  const partial = `${own}.partial`;
  fs.rmSync(partial, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(partial); // a consistent copy, even while another version has it open
  } finally {
    db.close();
  }
  fs.renameSync(partial, own);
  console.log(`This version (${version}) works on its own database: copied ${path.basename(source)} to ${path.basename(own)} (the original is unchanged).`);
  return own;
}

/** The most recently used database of this version or older, or null. */
function latestUsable(dataDir: string, version: string): string | null {
  const own = parseVersion(version);
  let best: { file: string; used: number } | null = null;
  for (const name of fs.readdirSync(dataDir)) {
    const v = name === LEGACY ? [0, 0, 0] : VERSIONED.exec(name)?.slice(1).map(Number);
    if (!v || compare(v, own) > 0) continue;
    const file = path.join(dataDir, name);
    const used = lastUsed(file);
    if (!best || used > best.used) best = { file, used };
  }
  return best?.file ?? null;
}

/** When a database last changed: SQLite writes to its -wal file first. */
function lastUsed(file: string): number {
  const times = [file, `${file}-wal`].flatMap((f) => (fs.existsSync(f) ? [fs.statSync(f).mtimeMs] : []));
  return Math.max(...times);
}

function parseVersion(version: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`Not a version: ${version}`);
  return m.slice(1).map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
