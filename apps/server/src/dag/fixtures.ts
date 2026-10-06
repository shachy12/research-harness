import type { BranchResult, DagNode, Message } from '@harness/shared';
import { GraphSnapshot } from './graph.ts';

// Small builder for test graphs: node('A', ['root'], { messages: ['u: hi', 'a: hello'] }).
type NodeSpec = {
  status?: DagNode['status']; result?: BranchResult; messages?: string[]; sessionId?: string;
  forkPoint?: number; forkSession?: string;
};

export function result(findings: string): BranchResult {
  return { findings, evidence: `${findings} evidence`, openQuestions: '', confidence: 'medium' };
}

export function buildGraph(specs: Record<string, [parents: string[], spec?: NodeSpec]>): GraphSnapshot {
  const nodes: DagNode[] = [];
  const messages: Message[] = [];
  for (const [id, [parentIds, spec = {}]] of Object.entries(specs)) {
    nodes.push({
      id,
      projectId: 'p',
      title: `Title ${id}`,
      titleSource: 'prompt',
      promptTitle: `Title ${id}`,
      parentIds,
      forkPoint: spec.forkPoint ?? null,
      forkSession: spec.forkSession ?? null,
      status: spec.status ?? 'open',
      result: spec.result ?? null,
      resultUpto: spec.result ? (spec.messages?.length ?? 0) : null,
      mergeResults: null,
      mergePrompt: null,
      filesFromProject: false,
      sessionId: spec.sessionId ?? null,
      readUpto: null,
      model: null,
      effort: null,
      gitBranch: null,
      filesChanged: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    (spec.messages ?? []).forEach((m, i) => {
      const [prefix, ...rest] = m.split(': ');
      messages.push({
        id: `${id}-m${i}`,
        nodeId: id,
        role: prefix === 'u' ? 'user' : 'assistant',
        content: rest.join(': '),
        toolCalls: [],
        attachments: [],
        model: null,
        forkProposal: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });
  }
  // A merge node received its parents' results (as a merge stores them).
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parentIds.length < 2) continue;
    n.mergeResults = n.parentIds.flatMap((p) => {
      const parent = byId.get(p)!;
      return parent.result ? [{ nodeId: p, upto: parent.resultUpto, result: parent.result }] : [];
    });
  }
  return new GraphSnapshot(nodes, messages);
}
