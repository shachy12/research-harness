import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BranchResult, DagNode, Message, NodeStatus, Project, Role, ToolCall } from '@harness/shared';
import { GraphSnapshot } from '../dag/graph.ts';
import { transaction } from './database.ts';

interface ProjectRow { id: string; name: string; created_at: string }
interface NodeRow {
  id: string; project_id: string; title: string; parent_ids: string;
  status: NodeStatus; result: string | null; session_id: string | null; created_at: string;
}
interface MessageRow {
  id: string; node_id: string; role: Role; content: string; tool_calls: string; created_at: string;
}

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at });
const toNode = (r: NodeRow): DagNode => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  parentIds: JSON.parse(r.parent_ids) as string[],
  status: r.status,
  result: r.result ? (JSON.parse(r.result) as BranchResult) : null,
  sessionId: r.session_id,
  createdAt: r.created_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  nodeId: r.node_id,
  role: r.role,
  content: r.content,
  toolCalls: JSON.parse(r.tool_calls) as ToolCall[],
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

  /** Create a project with an empty root node. */
  createProject(id: string, name: string, rootTitle: string): Project {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
      this.createNode({ projectId: id, title: rootTitle, parentIds: [] });
      return this.getProject(id)!;
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

  createNode(input: { projectId: string; title: string; parentIds: string[] }): DagNode {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO nodes (id, project_id, title, parent_ids, status, result, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(id, input.projectId, input.title, JSON.stringify(input.parentIds), 'open', now());
    return this.getNode(id)!;
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run(title, id);
  }

  setStatus(id: string, status: NodeStatus): void {
    this.db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, id);
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.prepare('UPDATE nodes SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  setResult(id: string, result: BranchResult): void {
    this.db
      .prepare("UPDATE nodes SET result = ?, status = 'finished' WHERE id = ?")
      .run(JSON.stringify(result), id);
  }

  // ---- messages ----

  addMessage(nodeId: string, role: Role, content: string, toolCalls: ToolCall[] = []): Message {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, node_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, nodeId, role, content, JSON.stringify(toolCalls), now());
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
