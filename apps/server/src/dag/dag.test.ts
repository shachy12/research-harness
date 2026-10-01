import { describe, expect, it } from 'vitest';
import { inheritedItems } from './context.ts';
import { buildGraph, result } from './fixtures.ts';
import { lowestCommonAncestor } from './graph.ts';
import { SYSTEM_PROMPT, branchStartNote, buildChatRequest } from './prompt.ts';

//        root
//      /  |  \
//     A   B   C        (A, B finished)
//      \ /
//       M              (merge of A + B)
//       |
//       M1             (branch of the merge node)
const graph = buildGraph({
  root: [[], { status: 'frozen', messages: ['u: scope it', 'a: three areas'] }],
  A: [['root'], { result: result('A found'), messages: ['u: a question', 'a: a answer'] }],
  B: [['root'], { result: result('B found'), messages: ['u: b question', 'a: b answer'] }],
  C: [['root'], { messages: ['u: c question'] }],
  M: [['A', 'B'], { status: 'frozen', messages: ['u: synthesize', 'a: synthesis'] }],
  M1: [['M'], { messages: ['u: follow up'] }],
});

const contents = (nodeId: string) => buildChatRequest(graph, nodeId).turns.map((t) => t.content);

describe('lowestCommonAncestor', () => {
  it('finds the fork point of sibling branches', () => {
    expect(lowestCommonAncestor(graph, ['A', 'B'])).toBe('root');
  });

  it('works through merge nodes', () => {
    expect(lowestCommonAncestor(graph, ['M1', 'C'])).toBe('root');
  });

  it('returns null when nodes share no ancestor', () => {
    expect(lowestCommonAncestor(graph, ['root', 'A'])).toBeNull();
  });
});

describe('inherited context', () => {
  it('root inherits nothing', () => {
    expect(inheritedItems(graph, 'root')).toEqual([]);
  });

  it('a branch inherits all of its parent messages', () => {
    const items = inheritedItems(graph, 'A');
    expect(items.map((i) => (i.kind === 'message' ? i.message.content : i.kind))).toEqual([
      'scope it',
      'three areas',
    ]);
  });

  it('a merge node inherits the base context plus results, never branch transcripts', () => {
    const items = inheritedItems(graph, 'M');
    expect(items.map((i) => (i.kind === 'message' ? i.message.content : `result:${i.nodeId}`))).toEqual([
      'scope it',
      'three areas',
      'result:A',
      'result:B',
    ]);
  });

  it('a branch of a merge node inherits the whole merge context', () => {
    const items = inheritedItems(graph, 'M1');
    expect(items.map((i) => (i.kind === 'message' ? i.message.content : `result:${i.nodeId}`))).toEqual([
      'scope it',
      'three areas',
      'result:A',
      'result:B',
      'synthesize',
      'synthesis',
    ]);
  });
});

describe('buildChatRequest', () => {
  it('uses the same system prompt for every node', () => {
    for (const id of ['root', 'A', 'M', 'M1']) {
      expect(buildChatRequest(graph, id).system).toBe(SYSTEM_PROMPT);
    }
  });

  it('marks where a branch starts, after the inherited turns', () => {
    expect(contents('A')).toEqual(['scope it', 'three areas', branchStartNote('Title A'), 'a question', 'a answer']);
  });

  it('sibling branches share an identical prefix up to the fork point', () => {
    const a = buildChatRequest(graph, 'A').turns;
    const c = buildChatRequest(graph, 'C').turns;
    expect(a.slice(0, 2)).toEqual(c.slice(0, 2));
  });

  it('puts the cache breakpoint on the last inherited turn only', () => {
    const turns = buildChatRequest(graph, 'A').turns;
    expect(turns.map((t) => !!t.cacheBreakpoint)).toEqual([false, true, false, false, false]);
    expect(buildChatRequest(graph, 'root').turns.some((t) => t.cacheBreakpoint)).toBe(false);
  });

  it('merge prompts contain the results but not the branch transcripts', () => {
    const text = contents('M').join('\n');
    expect(text).toContain('Findings: A found');
    expect(text).toContain('Findings: B found');
    expect(text).not.toContain('a question');
    expect(text).not.toContain('b answer');
  });

  it('appends extra turns at the end', () => {
    const req = buildChatRequest(graph, 'C', [{ role: 'user', content: 'extra' }]);
    expect(req.turns.at(-1)).toEqual({ role: 'user', content: 'extra' });
  });
});
