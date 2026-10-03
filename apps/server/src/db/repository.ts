import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, BranchResult, DagNode, Effort, Message, NodeStatus, Project, Role, TitleSource, ToolCall } from '@harness/shared';
import { GraphSnapshot } from '../dag/graph.ts';
import { transaction } from './database.ts';

interface ProjectRow { id: string; name: string; folder: string | null; archived: number; created_at: string }
interface NodeRow {
  id: string; project_id: string; title: string; parent_ids: string;
  status: NodeStatus; result: string | null; session_id: string | null; created_at: string;
  title_source: TitleSource; prompt_title: string | null; read_upto: string | null;
  model: string | null; effort: Effort | null; git_branch: string | null; files_changed: number | null;
}
interface MessageRow {
  id: string; node_id: string; role: Role; content: string; tool_calls: string; attachments: string;
  model: string | null; created_at: string;
}

// projects.editing (migration 8) was a per-project switch for file editing, dropped the same day: editing is always on.
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, folder: r.folder, archived: r.archived === 1, createdAt: r.created_at });
const toNode = (r: NodeRow): DagNode => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  titleSource: r.title_source,
  promptTitle: r.prompt_title ?? r.title,
  parentIds: JSON.parse(r.parent_ids) as string[],
  status: r.status,
  result: r.result ? (JSON.parse(r.result) as BranchResult) : null,
  sessionId: r.session_id,
  readUpto: r.read_upto,
  model: r.model,
  effort: r.effort,
  gitBranch: r.git_branch,
  filesChanged: r.files_changed,
  createdAt: r.created_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  nodeId: r.node_id,
  role: r.role,
  content: r.content,
  toolCalls: JSON.parse(r.tool_calls) as ToolCall[],
  attachments: JSON.parse(r.attachments) as Attachment[],
  model: r.model,
  createdAt: r.created_at,
});

const now = () => new Date().toISOString();

/** All SQL lives here. Routes and the context logic only see domain types. */
export class Repository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  // ---- projects ----

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  /** All projects with their node count and last activity, most recently used first. */
  listProjects(): (Project & { nodeCount: number; updatedAt: string })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id) AS node_count,
                COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN nodes n ON n.id = m.node_id
                          WHERE n.project_id = p.id), p.created_at) AS updated_at
         FROM projects p
         ORDER BY updated_at DESC, p.rowid`,
      )
      .all() as unknown as (ProjectRow & { node_count: number; updated_at: string })[];
    return rows.map((r) => ({ ...toProject(r), nodeCount: r.node_count, updatedAt: r.updated_at }));
  }

  /** Create a project with an empty root node. `folder` null means the default location. */
  createProject(id: string, name: string, rootTitle: string, folder: string | null = null): Project {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(id, name, folder, now());
      this.createNode({ projectId: id, title: rootTitle, parentIds: [] });
      return this.getProject(id)!;
    });
  }

  setProjectName(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
  }

  setProjectArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  /** Delete a project with all its nodes and messages (they cascade). Its folder on disk is left alone. */
  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Delete every node and message in the project and start again from an empty root. */
  resetProject(projectId: string, rootTitle: string): DagNode {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM nodes WHERE project_id = ?').run(projectId); // messages cascade
      return this.createNode({ projectId, title: rootTitle, parentIds: [] });
    });
  }

  // ---- nodes ----

  getNode(id: string): DagNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  listNodes(projectId: string): DagNode[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY created_at, rowid')
      .all(projectId) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  createNode(input: {
    projectId: string;
    title: string;
    parentIds: string[];
    titleSource?: TitleSource;
    model?: string | null;
    effort?: Effort | null;
  }): DagNode {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO nodes (id, project_id, title, title_source, prompt_title, parent_ids, status, result, model, effort, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)`)
      .run(id, input.projectId, input.title, input.titleSource ?? 'prompt', input.title, JSON.stringify(input.parentIds),
        input.model ?? null, input.effort ?? null, now());
    return this.getNode(id)!;
  }

  /** The model and effort the node's next replies use (null: the provider's default). */
  setModelSettings(id: string, model: string | null, effort: Effort | null): void {
    this.db.prepare('UPDATE nodes SET model = ?, effort = ? WHERE id = ?').run(model, effort, id);
  }

  /** Rename a node. `prompt_title` stays as it was, so the model's context doesn't change. */
  setTitle(id: string, title: string, source: TitleSource): void {
    this.db.prepare('UPDATE nodes SET title = ?, title_source = ? WHERE id = ?').run(title, source, id);
  }

  setStatus(id: string, status: NodeStatus): void {
    this.db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, id);
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.prepare('UPDATE nodes SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  /** The node's git branch (set once its worktree exists) and how many files it changes. */
  setGitInfo(id: string, branch: string, filesChanged: number | null): void {
    this.db.prepare('UPDATE nodes SET git_branch = ?, files_changed = ? WHERE id = ?').run(branch, filesChanged, id);
  }

  /**
   * Record that the user has read up to `messageId`. Only moves forward, and only to a message of
   * this node. Returns whether it moved.
   */
  markRead(nodeId: string, messageId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE nodes SET read_upto = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND node_id = ?)
           AND COALESCE((SELECT seq FROM messages WHERE id = nodes.read_upto), 0)
               < (SELECT seq FROM messages WHERE id = ?)`,
      )
      .run(messageId, nodeId, messageId, nodeId, messageId);
    return Number(result.changes) > 0;
  }

  setResult(id: string, result: BranchResult): void {
    this.db
      .prepare("UPDATE nodes SET result = ?, status = 'finished' WHERE id = ?")
      .run(JSON.stringify(result), id);
  }

  // ---- messages ----

  addMessage(
    nodeId: string,
    role: Role,
    content: string,
    {
      toolCalls = [],
      attachments = [],
      model = null,
    }: { toolCalls?: ToolCall[]; attachments?: Attachment[]; model?: string | null } = {},
  ): Message {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, node_id, role, content, tool_calls, attachments, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, nodeId, role, content, JSON.stringify(toolCalls), JSON.stringify(attachments), model, now());
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow;
    return toMessage(row);
  }

  listMessages(nodeId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE node_id = ? ORDER BY seq')
      .all(nodeId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Load a whole project into memory for the context logic. Projects are small enough for this. */
  snapshot(projectId: string): GraphSnapshot {
    const rows = this.db
      .prepare('SELECT m.* FROM messages m JOIN nodes n ON n.id = m.node_id WHERE n.project_id = ? ORDER BY m.seq')
      .all(projectId) as unknown as MessageRow[];
    return new GraphSnapshot(this.listNodes(projectId), rows.map(toMessage));
  }
}
