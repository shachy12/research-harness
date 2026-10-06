import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, BranchResult, DagNode, DeletedNode, Effort, ForkProposal, MergedResult, Message, NodeStatus, Project, Role, TitleSource, ToolCall } from '@harness/shared';
import { GraphSnapshot } from '../dag/graph.ts';
import { transaction } from './database.ts';

interface ProjectRow { id: string; name: string; folder: string | null; archived: number; created_at: string }
interface NodeRow {
  id: string; project_id: string; title: string; parent_ids: string;
  status: NodeStatus; result: string | null; session_id: string | null; created_at: string;
  title_source: TitleSource; prompt_title: string | null; read_upto: string | null;
  model: string | null; effort: Effort | null; git_branch: string | null; files_changed: number | null;
  fork_point: number | null; fork_session: string | null;
  result_upto: number | null; merge_results: string | null; merge_prompt: string | null; files_from_project: number;
  deleted_at: string | null; deleted_links: string | null;
}

/** How a child of a deleted node was attached before it became a root (restoring puts it back). */
interface DeletedLink {
  id: string; parentIds: string[]; forkPoint: number | null; forkSession: string | null; mergePrompt: string | null;
}
interface MessageRow {
  id: string; node_id: string; role: Role; content: string; tool_calls: string; attachments: string;
  model: string | null; fork_proposal: string | null; created_at: string;
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
  forkPoint: r.fork_point,
  forkSession: r.fork_session,
  status: r.status,
  result: r.result ? (JSON.parse(r.result) as BranchResult) : null,
  resultUpto: r.result_upto,
  mergeResults: r.merge_results ? (JSON.parse(r.merge_results) as MergedResult[]) : null,
  mergePrompt: r.merge_prompt,
  filesFromProject: r.files_from_project === 1,
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
  forkProposal: r.fork_proposal ? (JSON.parse(r.fork_proposal) as ForkProposal) : null,
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
                (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.deleted_at IS NULL) AS node_count,
                COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN nodes n ON n.id = m.node_id
                          WHERE n.project_id = p.id AND n.deleted_at IS NULL), p.created_at) AS updated_at
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

  /** A node, unless it doesn't exist or was deleted (`includeDeleted` finds those too). */
  getNode(id: string, { includeDeleted = false } = {}): DagNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row && (includeDeleted || row.deleted_at === null) ? toNode(row) : null;
  }

  /** The project's nodes, without deleted ones. */
  listNodes(projectId: string): DagNode[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid')
      .all(projectId) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  /** Deleted nodes of the project, most recently deleted first (they can be restored). */
  listDeleted(projectId: string): DeletedNode[] {
    const rows = this.db
      .prepare(`SELECT n.*, (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count
                FROM nodes n WHERE n.project_id = ? AND n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC, n.rowid DESC`)
      .all(projectId) as unknown as (NodeRow & { message_count: number })[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      deletedAt: r.deleted_at!,
      messageCount: r.message_count,
      childCount: r.deleted_links ? (JSON.parse(r.deleted_links) as DeletedLink[]).length : 0,
    }));
  }

  createNode(input: {
    projectId: string;
    title: string;
    parentIds: string[];
    titleSource?: TitleSource;
    model?: string | null;
    effort?: Effort | null;
    /** A branch's fork point (see `DagNode.forkPoint` / `forkSession`). */
    forkPoint?: number | null;
    forkSession?: string | null;
    /** A merge node's first message, sent once its results are drafted. */
    mergePrompt?: string | null;
    filesFromProject?: boolean;
  }): DagNode {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO nodes (id, project_id, title, title_source, prompt_title, parent_ids, status, result, model, effort,
                  fork_point, fork_session, merge_prompt, files_from_project, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.title, input.titleSource ?? 'prompt', input.title, JSON.stringify(input.parentIds),
        input.model ?? null, input.effort ?? null, input.forkPoint ?? null, input.forkSession ?? null,
        input.mergePrompt ?? null, input.filesFromProject ? 1 : 0, now());
    return this.getNode(id)!;
  }

  /**
   * Delete a node: it is only marked deleted (hidden, with its messages kept), so it can be
   * restored. Its children become roots (no parents, no fork point): they keep their own messages
   * and sessions. A child merge that never started loses its pending first message (it becomes an
   * empty root). How each child was attached is kept for `restoreNode`. Returns the children's ids.
   */
  deleteNode(id: string): string[] {
    return this.transaction(() => {
      const node = this.getNode(id);
      if (!node) return [];
      const children = this.listNodes(node.projectId).filter((n) => n.parentIds.includes(id));
      const links: DeletedLink[] = children.map((c) => ({
        id: c.id, parentIds: c.parentIds, forkPoint: c.forkPoint, forkSession: c.forkSession, mergePrompt: c.mergePrompt,
      }));
      for (const child of children) {
        this.db
          .prepare(`UPDATE nodes SET parent_ids = '[]', fork_point = NULL, fork_session = NULL,
                      merge_prompt = CASE WHEN EXISTS (SELECT 1 FROM messages WHERE node_id = nodes.id) THEN merge_prompt END
                    WHERE id = ?`)
          .run(child.id);
      }
      this.db.prepare('UPDATE nodes SET deleted_at = ?, deleted_links = ? WHERE id = ?').run(now(), JSON.stringify(links), id);
      return children.map((c) => c.id);
    });
  }

  /**
   * Undo a delete: the node is back where it was, and its children that are still roots are
   * attached to it again as before (a child deleted meanwhile too, so restoring it later puts it
   * back here). If one of its own parents was deleted meanwhile, it comes back as a root. Returns
   * the node, or null if it isn't a deleted node.
   */
  restoreNode(id: string): DagNode | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM nodes WHERE id = ? AND deleted_at IS NOT NULL').get(id) as NodeRow | undefined;
      if (!row) return null;
      const node = toNode(row);
      if (node.parentIds.some((p) => !this.getNode(p))) {
        this.db.prepare(`UPDATE nodes SET parent_ids = '[]', fork_point = NULL, fork_session = NULL WHERE id = ?`).run(id);
      }
      for (const link of JSON.parse(row.deleted_links ?? '[]') as DeletedLink[]) {
        const child = this.getNode(link.id, { includeDeleted: true });
        if (!child || child.parentIds.length > 0 || link.parentIds.some((p) => p !== id && !this.getNode(p))) continue;
        this.db
          .prepare('UPDATE nodes SET parent_ids = ?, fork_point = ?, fork_session = ?, merge_prompt = COALESCE(merge_prompt, ?) WHERE id = ?')
          .run(JSON.stringify(link.parentIds), link.forkPoint, link.forkSession,
            this.listMessages(link.id).length === 0 ? link.mergePrompt : null, link.id);
      }
      this.db.prepare('UPDATE nodes SET deleted_at = NULL, deleted_links = NULL WHERE id = ?').run(id);
      return this.getNode(id);
    });
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

  /** The result drafted for a merge, covering the node's first `upto` messages (its status stays). */
  setResult(id: string, result: BranchResult, upto: number): void {
    this.db.prepare('UPDATE nodes SET result = ?, result_upto = ? WHERE id = ?').run(JSON.stringify(result), upto, id);
  }

  /** The results a merge node received (set once, when its drafts are done). */
  setMergeResults(id: string, results: MergedResult[]): void {
    this.db.prepare('UPDATE nodes SET merge_results = ? WHERE id = ?').run(JSON.stringify(results), id);
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
      forkProposal = null,
    }: { toolCalls?: ToolCall[]; attachments?: Attachment[]; model?: string | null; forkProposal?: ForkProposal | null } = {},
  ): Message {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO messages (id, node_id, role, content, tool_calls, attachments, model, fork_proposal, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, nodeId, role, content, JSON.stringify(toolCalls), JSON.stringify(attachments), model,
        forkProposal ? JSON.stringify(forkProposal) : null, now());
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
      .prepare('SELECT m.* FROM messages m JOIN nodes n ON n.id = m.node_id WHERE n.project_id = ? AND n.deleted_at IS NULL ORDER BY m.seq')
      .all(projectId) as unknown as MessageRow[];
    return new GraphSnapshot(this.listNodes(projectId), rows.map(toMessage));
  }
}
