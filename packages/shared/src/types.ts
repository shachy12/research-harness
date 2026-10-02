// Core domain types shared by the server and the web UI.

export interface Project {
  id: string;
  name: string;
  /**
   * The project's working folder: the model runs there and can read files in it (and nowhere else).
   * Null means the default location under the app's data folder. Managed data lives in `.harness/`.
   */
  folder: string | null;
  createdAt: string;
}

/** A file or folder the user attached to a message; copied into the project's `.harness/uploads/` folder. */
export interface Attachment {
  name: string;
  /** Absolute path of the copy in `.harness/uploads/`. */
  path: string;
  /** Total bytes (all files, for a folder). */
  size: number;
  /** Missing on older messages, which were always files. */
  kind?: 'file' | 'folder';
  /** Number of files inside, for a folder. */
  fileCount?: number;
}

/**
 * open:     accepts new messages
 * frozen:   has been forked; history is fixed so merges stay unambiguous
 * finished: has an approved result that can be merged
 */
export type NodeStatus = 'open' | 'frozen' | 'finished';

export type Confidence = 'low' | 'medium' | 'high';

/** The distilled output of a branch. Only this flows into a merge, never the transcript. */
export interface BranchResult {
  findings: string;
  evidence: string;
  openQuestions: string;
  confidence: Confidence;
}

export interface DagNode {
  id: string;
  projectId: string;
  title: string;
  /** Empty for the root, one id for a normal branch, two or more for a merge node. */
  parentIds: string[];
  status: NodeStatus;
  result: BranchResult | null;
  /** The Claude Code session holding this node's conversation (claude-code provider only). */
  sessionId: string | null;
  createdAt: string;
}

export type Role = 'user' | 'assistant';

export interface Message {
  id: string;
  nodeId: string;
  role: Role;
  content: string;
  /** Searches and fetches the model ran while writing this reply (empty for user messages). */
  toolCalls: ToolCall[];
  /** Files attached to this message (user messages only). */
  attachments: Attachment[];
  createdAt: string;
}

/** A web search or page fetch run by the model (server-side tools). */
export interface ToolCall {
  id: string;
  /** 'web_search' or 'web_fetch'. */
  name: string;
  /** The search query or the fetched URL. */
  input: string;
  status: 'running' | 'done' | 'error';
  results: { title: string; url: string }[];
  error?: string;
}

/** One entry of what a node inherits: an ancestor's message, or a merged branch's result. */
export type ContextItem =
  | { kind: 'message'; nodeId: string; nodeTitle: string; message: Message }
  | { kind: 'result'; nodeId: string; nodeTitle: string; result: BranchResult };

// ---- API responses ----

/** A node as shown on a graph card. */
export interface NodeSummary extends DagNode {
  messageCount: number;
  lastMessage: string | null;
  /** Who wrote the last message; 'user' on an idle node means the reply failed or was stopped early. */
  lastRole: Role | null;
  /** The model is writing a reply right now. */
  running: boolean;
  /** When the running reply started and what it is doing; null when not running. */
  run: RunStatus | null;
}

export interface RunStatus {
  startedAt: string;
  /** e.g. "Thinking", "Searching the web: …", "Reading main.tex", "Writing". */
  activity: string;
}

export interface GraphResponse {
  project: Project;
  nodes: NodeSummary[];
}

export interface NodeDetail {
  node: DagNode;
  messages: Message[];
  /** Everything the node inherits, in prompt order. */
  inherited: ContextItem[];
  childIds: string[];
  /** The model is writing a reply right now (attach with GET /api/nodes/:id/stream). */
  running: boolean;
  run: RunStatus | null;
}

/**
 * Server-sent events about a node's reply. Replies run on the server; a page only watches them.
 *   POST /api/nodes/:id/messages  starts a reply: `user`, then the live events
 *   GET  /api/nodes/:id/stream    attaches to a running reply: `snapshot` of the reply so far,
 *                                 then the live events; or `idle` if nothing is running
 * `thinking` marks that the model started reasoning (its text is not shown).
 */
export type ChatStreamEvent =
  | { type: 'user'; message: Message }
  | { type: 'snapshot'; text: string; toolCalls: ToolCall[]; thinking: boolean; startedAt: string }
  | { type: 'idle' }
  | { type: 'thinking' }
  | { type: 'delta'; text: string }
  /** A tool call started or got its results; replaces any earlier event with the same call id. */
  | { type: 'tool'; call: ToolCall }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string };

export interface ApiError {
  error: string;
}
