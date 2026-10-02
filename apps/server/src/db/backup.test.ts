import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { KEEP_DAILY, backupDatabase, dailyBackup, listBackups, pruneDailyBackups } from './backup.ts';
import { MIGRATIONS, backupDirOf, openDatabase } from './database.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-backup-'));
});

const projectNames = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const names = (db.prepare('SELECT name FROM projects').all() as { name: string }[]).map((r) => r.name);
  db.close();
  return names;
};

describe('backups', () => {
  it('copies the database with its data', () => {
    const db = openDatabase(path.join(dir, 'harness.db'));
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'My paper', 'now')").run();
    const copy = backupDatabase(db, backupDirOf(path.join(dir, 'harness.db')), 'manual');
    expect(path.basename(copy)).toMatch(/^harness-\d{8}-\d{6}-manual\.db$/);
    expect(projectNames(copy)).toEqual(['My paper']);
  });

  it('backs up an existing database before migrating it', () => {
    const file = path.join(dir, 'harness.db');
    // An "old" database: only the first migration has run, and it holds research.
    const old = openDatabase(file, MIGRATIONS.slice(0, 1));
    old.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Paper A', 'now')").run();
    old.close();

    const db = openDatabase(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);

    const backups = listBackups(backupDirOf(file));
    expect(backups.map((b) => b.name)).toEqual([expect.stringMatching(/-before-migration-v2\.db$/)]);
    const copy = new DatabaseSync(path.join(backupDirOf(file), backups[0].name), { readOnly: true });
    expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    copy.close();
    expect(projectNames(path.join(backupDirOf(file), backups[0].name))).toEqual(['Paper A']);
  });

  it('makes no migration backup for a new or an up-to-date database', () => {
    const file = path.join(dir, 'harness.db');
    openDatabase(file).close(); // new
    openDatabase(file).close(); // up to date
    expect(listBackups(backupDirOf(file))).toEqual([]);
  });

  it('makes a daily backup at most once a day', () => {
    const db = openDatabase(path.join(dir, 'harness.db'));
    const backups = path.join(dir, 'backups');
    expect(dailyBackup(db, backups)).not.toBeNull();
    expect(dailyBackup(db, backups)).toBeNull(); // same day
    expect(dailyBackup(db, backups, Date.now() + 25 * 60 * 60 * 1000)).not.toBeNull(); // next day
  });

  it('keeps only the newest daily backups and never deletes the others', () => {
    const backups = path.join(dir, 'backups');
    const make = (name: string, ageDays: number) => {
      const file = path.join(backups, name);
      writeFileSync(file, '');
      const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      utimesSync(file, t, t);
    };
    backupDatabase(openDatabase(path.join(dir, 'harness.db')), backups, 'manual');
    for (let i = 0; i < KEEP_DAILY + 5; i++) make(`harness-2026010${i % 10}-0000${String(i).padStart(2, '0')}-daily.db`, i + 1);
    make('harness-20250101-000000-before-migration-v3.db', 400);
    make('harness-20250101-000001-before-reset.db', 400);

    pruneDailyBackups(backups);
    const names = listBackups(backups).map((b) => b.name);
    expect(names.filter((n) => n.endsWith('-daily.db'))).toHaveLength(KEEP_DAILY);
    expect(names).toEqual(expect.arrayContaining([
      expect.stringMatching(/-manual\.db$/),
      'harness-20250101-000000-before-migration-v3.db',
      'harness-20250101-000001-before-reset.db',
    ]));
  });
});
