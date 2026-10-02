import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from './backup.ts';

// Schema changes are appended here, never edited. PRAGMA user_version records how many have run.
// The user's research lives in this database: a migration must never delete or rewrite their
// messages, results or nodes. (A backup is made before migrating anyway — see openDatabase.)
export const MIGRATIONS: string[] = [
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
  // 4: per-project working folders and file attachments. Claude Code sessions are tied to the
  // folder they were created in, and earlier ones used a shared folder, so they can't be resumed:
  // clear them, and the next message replays the conversation as a transcript instead.
  `
  ALTER TABLE projects ADD COLUMN folder TEXT;
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  UPDATE nodes SET session_id = NULL;
  `,
  // 5: where a title came from (the model may replace 'prompt' titles, never 'user' ones), and the
  // title a node was created with, which prompts keep using after a rename.
  `
  ALTER TABLE nodes ADD COLUMN title_source TEXT NOT NULL DEFAULT 'prompt'
    CHECK (title_source IN ('prompt', 'model', 'user'));
  ALTER TABLE nodes ADD COLUMN prompt_title TEXT;
  UPDATE nodes SET prompt_title = title;
  `,
  // 6: the last message the user has read in each node. Nodes that exist now count as fully read
  // (so nothing is flagged new on upgrade); new nodes start with NULL (never opened).
  `
  ALTER TABLE nodes ADD COLUMN read_upto TEXT;
  UPDATE nodes SET read_upto =
    (SELECT m.id FROM messages m WHERE m.node_id = nodes.id ORDER BY m.seq DESC LIMIT 1);
  `,
  // 7: model and effort per node (NULL: the provider's default, so existing nodes keep working as
  // before) and which model wrote each reply. projects.model / projects.effort were for a project
  // default that was dropped again (the root node's setting plays that role); they stay unused.
  `
  ALTER TABLE nodes ADD COLUMN model TEXT;
  ALTER TABLE nodes ADD COLUMN effort TEXT;
  ALTER TABLE projects ADD COLUMN model TEXT;
  ALTER TABLE projects ADD COLUMN effort TEXT;
  ALTER TABLE messages ADD COLUMN model TEXT;
  `,
];

/** Where backups of a database file go: `backups/` next to it. */
export const backupDirOf = (file: string) => path.join(path.dirname(file), 'backups');

/**
 * Open (or create) the database and bring its schema up to date. Pass ':memory:' for tests.
 * An existing database is backed up before any migration runs, so a bad migration can't lose data.
 */
export function openDatabase(file: string, migrations: string[] = MIGRATIONS): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (file !== ':memory:' && version > 0 && version < migrations.length) {
    const backup = backupDatabase(db, backupDirOf(file), `before-migration-v${version + 1}`);
    console.log(`database backed up before migrating: ${backup}`);
  }
  for (let i = version; i < migrations.length; i++) {
    transaction(db, () => {
      db.exec(migrations[i]);
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
