// Core domain types shared by the server and the web UI.

export interface Project {
  id: string;
  name: string;
  /**
   * The project's working folder: the model runs there and can read files in it (and nowhere else).
   * Null means the default location under the app's data folder. Managed data lives in `.harness/`.
   */
  folder: string | null;
  /** Listed in the sidebar's "Archives" group (collapsed by default) instead of with the others. */
  archived: boolean;
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
 * open:     accepts new messages (also after it was forked: its branches keep what it was then)
 * finished: has an approved result that can be merged
 *
 * Until 2026-10-05 a forked node was 'frozen' (no more messages); migration 11 reopened them.
 */
export type NodeStatus = 'open' | 'finished';

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
  /**
   * A branch's fork point: how many of its parent's messages it inherits (the parent may go on
   * after the fork). Null for the root and merge nodes.
   */
  forkPoint: number | null;
  /**
   * The parent's Claude Code session at the fork point. The parent continues in a copy of it
   * (`planSession`), so this one stays as it was: the branch (or a merge based there) forks it.
   */
  forkSession: string | null;
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
  /**
   * The node's git branch once it has its own editable copy of the project (a git worktree in
   * `.harness/work/`); the user applies its changes to the project after seeing the diff.
   */
  gitBranch: string | null;
  /** How many files its branch changes compared with the project, as of its last reply (null: no branch). */
  filesChanged: number | null;
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
  /** 'claude-code' or 'placeholder'. */
  provider: string;
  models: ModelOption[];
  /** What a node with no setting of its own uses (always sent to the provider, never left to the account). */
  defaultModel: string;
  defaultEffort: Effort;
  /**
   * Whether a branch's first reply can reuse its parent's prompt cache when both use the same
   * model and effort. True on the API and on Claude Code (there since the CLI's Message Threads
   * are turned off, see `cliEnv`; measured 2026-10-02).
   */
  forkKeepsCache: boolean;
  /** The provider can edit files (Claude Code): every node then edits its own copy of the project. */
  canEdit: boolean;
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
  /** Branches the model proposed with its fork_branches tool while writing this reply (null: none). */
  forkProposal: ForkProposal | null;
  createdAt: string;
}

/**
 * Branches the model proposed (fork_branches tool on the harness MCP server). Nothing is created
 * until the user reviews them in the fork dialog and starts them.
 */
export interface ForkProposal {
  branches: { prompt: string; title: string | null }[];
}

/** A tool the model ran: web search/fetch, a file read or edit, a shell command. */
export interface ToolCall {
  id: string;
  /**
   * 'web_search', 'web_fetch', 'read_file', 'find_files', 'search_files', 'edit_file', 'write_file',
   * 'shell', or the harness tools 'fork_branches' and 'ask_node'.
   */
  name: string;
  /** The search query, URL, file path, search pattern, shell command, or the question asked of a node. */
  input: string;
  status: 'running' | 'done' | 'error';
  results: { title: string; url: string }[];
  error?: string;
  /** What a shell command printed (its end, if long), or a node's answer (ask_node). */
  output?: string;
  /** The node an ask_node call asked (its title as of the call). */
  node?: { id: string; title: string };
  /**
   * How much of the reply's text came before the call (characters), so the chat shows it in place.
   * Missing on replies saved before 2026-10-05: their calls show before the text.
   */
  offset?: number;
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
  /** Branches the model proposed in its last reply, waiting for the user (0: none). */
  proposedBranches: number;
  /** Branches were forked off at the node's current end (nothing was added since): its card says "Forked". */
  forkedAtEnd: boolean;
}

export interface RunStatus {
  startedAt: string;
  /** e.g. "Thinking", "Searching the web: …", "Reading main.tex", "Writing". */
  activity: string;
  /** The reply is paused until the user allows more ask_node questions (null: not waiting). */
  approval: AskApproval | null;
}

/**
 * ask_node questions waiting for the user's approval: the reply already used its free questions
 * (HARNESS_ASK_LIMIT per user message). Questions asked at the same moment wait together.
 */
export interface AskApproval {
  /** `from`: the node asking, when it isn't the reply's own node (a node it asked asks further). */
  asks: { nodeTitle: string; from: string | null; question: string }[];
  /** How many questions one message allows without approval (also what approving grants again). */
  limit: number;
  /** When the questions count as unanswered (the user is probably away). */
  expiresAt: string;
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
  /** Where branches were forked off this node: after `at` of its messages, these branches. Oldest first. */
  forks: { at: number; childIds: string[] }[];
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
  | { type: 'snapshot'; text: string; toolCalls: ToolCall[]; thinking: boolean; startedAt: string; approval: AskApproval | null }
  /** ask_node questions now wait for the user's approval, or no longer do (null). */
  | { type: 'approval'; approval: AskApproval | null }
  | { type: 'idle' }
  | { type: 'thinking' }
  | { type: 'delta'; text: string }
  /** A tool call started or got its results; replaces any earlier event with the same call id. */
  | { type: 'tool'; call: ToolCall }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string; kind?: ErrorKind; resetsAt?: string | null };

/** One file a node's branch changes. Line counts are null for binary files. */
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number | null;
  deletions: number | null;
}

/**
 * GET /api/nodes/:id/changes: what applying the node's branch would bring into the project's
 * current branch (`target`), compared from where they split.
 */
export interface NodeChanges {
  branch: string;
  /** The project's checked-out branch; null on a detached HEAD. */
  target: string | null;
  files: FileChange[];
  /** Unified diff (cut at a size limit, see `truncated`). */
  diff: string;
  truncated: boolean;
  /** Files that would conflict with the project's branch if applied now. */
  conflicts: string[];
  /** Changed files that still contain merge conflict markers (from merging branches; not resolved yet). */
  unresolved: string[];
  /** Everything on the branch is already in the project's branch. */
  applied: boolean;
}

/** POST /api/projects/:id/merge/preview: what merging the selected branches does to their files. */
export interface MergePreview {
  /** Branches with an editable copy and the files each changed (from where they split). */
  branches: { nodeId: string; title: string; files: string[] }[];
  /** Files that will get conflict markers; the merged node's first reply is asked to resolve them. */
  conflicts: string[];
}

/**
 * POST /api/projects/check-folder: what creating a project on this folder does in git, for the
 * new-project dialog's notice.
 */
export interface FolderGit {
  /** Already a git repository. If not, creating the project runs `git init` and commits its files. */
  repository: boolean;
  /** Its checked-out branch (null: detached HEAD), or the branch `git init` will create. */
  branch: string | null;
  /** Uncommitted changes: nodes start from the last commit, so they won't see them. */
  uncommitted: boolean;
}

export interface ApiError {
  error: string;
}
