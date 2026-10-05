import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { versionDatabase } from './database-file.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'harness-dbfile-'));
});

/** A database holding one value, last used `minutesAgo`. */
function makeDb(name: string, value: string, minutesAgo: number) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS t (v TEXT); DELETE FROM t; INSERT INTO t VALUES ('${value}');`);
  db.close();
  const when = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, when, when);
}

const valueIn = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const { v } = db.prepare('SELECT v FROM t').get() as { v: string };
  db.close();
  return v;
};

describe('versionDatabase', () => {
  it('a first start with no data gets its own (new) file', () => {
    expect(versionDatabase(dir, '0.3.0')).toBe(path.join(dir, 'harness-v0.3.0.db'));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('copies the 0.2.1 database (harness.db) and leaves it as it was', () => {
    makeDb('harness.db', 'from 0.2.1', 10);
    const before = fs.readFileSync(path.join(dir, 'harness.db'));
    const file = versionDatabase(dir, '0.3.0');
    expect(file).toBe(path.join(dir, 'harness-v0.3.0.db'));
    expect(valueIn(file)).toBe('from 0.2.1');
    expect(fs.readFileSync(path.join(dir, 'harness.db')).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
  });

  it('keeps using its own file once it has one', () => {
    makeDb('harness.db', 'legacy', 1);
    makeDb('harness-v0.3.0.db', 'own', 60);
    expect(valueIn(versionDatabase(dir, '0.3.0'))).toBe('own');
  });

  it('copies the most recently used database of the same or an older version, never a newer one', () => {
    makeDb('harness.db', 'legacy', 30);
    makeDb('harness-v0.3.0.db', 'v0.3.0', 20);
    makeDb('harness-v0.10.0.db', 'v0.10.0', 0); // newest, but a newer version than 0.4.0
    const v040 = versionDatabase(dir, '0.4.0');
    expect(valueIn(v040)).toBe('v0.3.0');

    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(v040, tenMinutesAgo, tenMinutesAgo); // 0.4.0 was last used then...
    makeDb('harness.db', 'legacy, used again', 5); // ...then back on 0.2.1, working there
    expect(valueIn(versionDatabase(dir, '0.5.0'))).toBe('legacy, used again');
    expect(fs.readdirSync(dir).sort()).toEqual(['harness-v0.10.0.db', 'harness-v0.3.0.db', 'harness-v0.4.0.db', 'harness-v0.5.0.db', 'harness.db']);
  });
});
