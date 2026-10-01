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
