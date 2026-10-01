import type { BranchResult, DagNode, Message } from '@harness/shared';
import { GraphSnapshot } from './graph.ts';

// Small builder for test graphs: node('A', ['root'], { messages: ['u: hi', 'a: hello'] }).
type NodeSpec = { status?: DagNode['status']; result?: BranchResult; messages?: string[] };

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
      parentIds,
      status: spec.status ?? (spec.result ? 'finished' : 'open'),
      result: spec.result ?? null,
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
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });
  }
  return new GraphSnapshot(nodes, messages);
}
