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

/** Where a node's title came from. The model only replaces `prompt` titles; a user rename is final. */
export type TitleSource = 'prompt' | 'model' | 'user';

export interface DagNode {
  id: string;
  projectId: string;
  title: string;
  titleSource: TitleSource;
  /**
   * The title the node was created with. Prompts use this one, so renaming a node never changes
   * what the model sees (or invalidates its prompt cache).
   */
  promptTitle: string;
  /** Empty for the root, one id for a normal branch, two or more for a merge node. */
  parentIds: string[];
  status: NodeStatus;
  result: BranchResult | null;
  /** The Claude Code session holding this node's conversation (claude-code provider only). */
  sessionId: string | null;
  /**
   * Id of the last message the user has read; only moves forward. Null: nothing read yet (a node
   * that was never opened).
   */
  readUpto: string | null;
  /**
   * The model and effort this node's replies use; null means the provider's default. A new node
   * copies them from its parent (a merge: from its merge base) unless it was given its own.
   */
  model: string | null;
  effort: Effort | null;
  createdAt: string;
}

/** How hard the model thinks before answering (Claude's effort levels, lowest to highest). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A model the current provider can use, with the effort levels it accepts (empty: no effort setting). */
export interface ModelOption {
  id: string;
  efforts: Effort[];
}

/** GET /api/models: what the model pickers offer. */
export interface ModelsResponse {
  /** 'claude-code' (subscription), 'anthropic' (API, pay per token) or 'placeholder'. */
  provider: string;
  models: ModelOption[];
  /** What a node with no setting of its own uses (always sent to the provider, never left to the account). */
  defaultModel: string;
  defaultEffort: Effort;
  /**
   * Whether a branch's first reply can reuse its parent's prompt cache when both use the same
   * model and effort. True on the API. False on Claude Code: a new or resumed CLI process doesn't
   * reuse the cache of an earlier process (measured 2026-10-02), so a fork re-reads its history anyway.
   */
  forkKeepsCache: boolean;
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
  /** The model that wrote this reply, as the provider reported it (assistant messages; null on older ones). */
  model: string | null;
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

/** A project as listed in the sidebar. */
export interface ProjectSummary extends Project {
  nodeCount: number;
  /** Some node in the project is writing a reply. */
  running: boolean;
  /** The newest message (or the project's creation), for sorting. */
  updatedAt: string;
}

/** A node as shown on a graph card. */
export interface NodeSummary extends DagNode {
  messageCount: number;
  lastMessage: string | null;
  /** Who wrote the last message; 'user' on an idle node means the reply failed or was stopped early. */
  lastRole: Role | null;
  /** Assistant replies the user has not read yet (shown as "N new"). */
  unread: number;
  /** The model is writing a reply right now. */
  running: boolean;
  /** When the running reply started and what it is doing; null when not running. */
  run: RunStatus | null;
  /** A model-written title is on its way (refresh to show it). */
  titlePending: boolean;
}

export interface RunStatus {
  startedAt: string;
  /** e.g. "Thinking", "Searching the web: …", "Reading main.tex", "Writing". */
  activity: string;
}

export interface GraphResponse {
  project: Project;
  nodes: NodeSummary[];
  usage: UsageLimit | null;
}

/** Why a model call failed, so the UI can say it plainly. */
export type ErrorKind = 'usage_limit' | 'auth' | 'billing' | 'other';

/**
 * The Claude usage limit, as last reported: close to it (`warning`) or reached. Account-wide, so
 * it applies to every node. Null when nothing is known or the limit has reset.
 */
export interface UsageLimit {
  status: 'warning' | 'reached';
  /** When it resets (ISO time), if known. */
  resetsAt: string | null;
  /** e.g. 'five_hour', 'seven_day' (Claude Code), if known. */
  limitType: string | null;
  /** How much of the limit is used, 0–1, if the provider said (Claude Code does with its warnings). */
  utilization: number | null;
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
  titlePending: boolean;
  usage: UsageLimit | null;
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
  | { type: 'error'; error: string; kind?: ErrorKind; resetsAt?: string | null };

export interface ApiError {
  error: string;
}
