import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Schema changes are appended here, never edited. PRAGMA user_version records how many have run.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nodes (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    parent_ids TEXT NOT NULL,              -- JSON array of node ids, in merge order
    status     TEXT NOT NULL CHECK (status IN ('open', 'frozen', 'finished')),
    result     TEXT,                       -- JSON BranchResult, set when finished
    created_at TEXT NOT NULL
  );
  CREATE INDEX nodes_by_project ON nodes(project_id);

  CREATE TABLE messages (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- conversation order
    id         TEXT NOT NULL UNIQUE,
    node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_node ON messages(node_id, seq);
  `,
  // 2: web search / fetch calls made while writing a reply (JSON ToolCall[])
  `ALTER TABLE messages ADD COLUMN tool_calls TEXT NOT NULL DEFAULT '[]';`,
  // 3: Claude Code session id per node (claude-code provider)
  `ALTER TABLE nodes ADD COLUMN session_id TEXT;`,
];

/** Open (or create) the database and bring its schema up to date. Pass ':memory:' for tests. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
