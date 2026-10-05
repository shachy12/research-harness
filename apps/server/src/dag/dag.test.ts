import { describe, expect, it } from 'vitest';
import { inheritedItems, mergeBase, skippedByMerge } from './context.ts';
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
  root: [[], { messages: ['u: scope it', 'a: three areas'] }],
  A: [['root'], { result: result('A found'), messages: ['u: a question', 'a: a answer'] }],
  B: [['root'], { result: result('B found'), messages: ['u: b question', 'a: b answer'] }],
  C: [['root'], { messages: ['u: c question'] }],
  M: [['A', 'B'], { messages: ['u: synthesize', 'a: synthesis'] }],
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

describe('fork points (a node that goes on after it was forked)', () => {
  //   root: q1 a1 | q2 a2 | q3 a3     A forked after 2 messages (session S1), B after 4 (S2)
  //    /    \
  //   A      B          (both finished)
  //    \    /
  //      M
  const forked = buildGraph({
    root: [[], { sessionId: 'S3', messages: ['u: q1', 'a: a1', 'u: q2', 'a: a2', 'u: q3', 'a: a3'] }],
    A: [['root'], { forkPoint: 2, forkSession: 'S1', result: result('A found'), messages: ['u: a q', 'a: a answer'] }],
    B: [['root'], { forkPoint: 4, forkSession: 'S2', result: result('B found'), messages: ['u: b q', 'a: b answer'] }],
    M: [['A', 'B']],
  });
  const inherited = (id: string) => inheritedItems(forked, id).map((i) => (i.kind === 'message' ? i.message.content : `result ${i.nodeTitle}`));

  it('a branch inherits its parent only up to its fork point', () => {
    expect(inherited('A')).toEqual(['q1', 'a1']);
    expect(inherited('B')).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('a merge starts from the base at the earliest fork point, with its session from then', () => {
    expect(mergeBase(forked, ['A', 'B'])).toEqual({ id: 'root', upto: 2, session: 'S1' });
    expect(inherited('M')).toEqual(['q1', 'a1', 'result Title A', 'result Title B']);
  });

  it('cuts nothing when the base has nothing after the fork', () => {
    const g = buildGraph({
      root: [[], { sessionId: 'S0', messages: ['u: q', 'a: a'] }],
      A: [['root'], { forkPoint: 2, forkSession: 'S0', result: result('A') }],
      B: [['root'], { forkPoint: 2, forkSession: 'S0', result: result('B') }],
    });
    expect(mergeBase(g, ['A', 'B'])).toEqual({ id: 'root', upto: null, session: 'S0' });
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

describe('merge notes', () => {
  //        root
  //       /    \
  //      A      B        (B finished)
  //     / \
  //   A1   A2            (both finished)
  // X = A1 + B (cross-level, base root), Y = A1 + A2 (base A)
  const nested = buildGraph({
    root: [[], { messages: ['u: scope', 'a: two areas'] }],
    A: [['root'], { messages: ['u: area a', 'a: a details'] }],
    A1: [['A'], { result: result('A1 found'), messages: ['u: a1', 'a: a1 answer'] }],
    A2: [['A'], { result: result('A2 found'), messages: ['u: a2', 'a: a2 answer'] }],
    B: [['root'], { result: result('B found'), messages: ['u: b', 'a: b answer'] }],
    X: [['A1', 'B'], { messages: ['u: combine'] }],
    Y: [['A1', 'A2'], { messages: ['u: combine'] }],
  });

  it('lists the conversations a merge leaves out: the branches and what lies between them and the base', () => {
    expect(skippedByMerge(nested, ['A1', 'B'], 'root').map((n) => n.id)).toEqual(['A', 'B', 'A1']);
    expect(skippedByMerge(nested, ['A1', 'A2'], 'A').map((n) => n.id)).toEqual(['A1', 'A2']);
    expect(skippedByMerge(graph, ['A', 'B'], 'root').map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('names them with their node ids in the merge turn, for ask_node', () => {
    const merge = buildChatRequest(nested, 'X').turns.find((t) => t.content.startsWith('[Merge node'))!.content;
    expect(merge).toContain('- "Title A" (node A)');
    expect(merge).toContain('- "Title A1" (node A1)');
    expect(merge).toContain('ask_node');
    // A's conversation itself is not in X's context (only A1's result, written with it in view).
    expect(buildChatRequest(nested, 'X').turns.map((t) => t.content).join('\n')).not.toContain('a details');
  });
});
