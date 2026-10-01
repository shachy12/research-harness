// Core domain types shared by the server and the web UI.

export interface Project {
  id: string;
  name: string;
  createdAt: string;
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
  createdAt: string;
}

export type Role = 'user' | 'assistant';

export interface Message {
  id: string;
  nodeId: string;
  role: Role;
  content: string;
  createdAt: string;
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
}

/**
 * Server-sent events from POST /api/nodes/:id/messages.
 * `thinking` marks that the model started reasoning (its text is not shown).
 */
export type ChatStreamEvent =
  | { type: 'user'; message: Message }
  | { type: 'thinking' }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string };

export interface ApiError {
  error: string;
}
