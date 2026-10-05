import { describe, expect, it } from 'vitest';
import { buildGraph, result } from './fixtures.ts';
import { branchStartNote } from './prompt.ts';
import { firstMessage, planSession } from './session.ts';

//        root (session S0)
//      /  |  \
//     A   B   C          A, B finished with sessions; C has no messages yet
//      \ /
//       M                merge of A + B, no messages yet
const graph = buildGraph({
  root: [[], { sessionId: 'S0', messages: ['u: scope it', 'a: three areas'] }],
  A: [['root'], { sessionId: 'SA', result: result('A found'), messages: ['u: a q', 'a: a answer'] }],
  B: [['root'], { sessionId: 'SB', result: result('B found'), messages: ['u: b q', 'a: b answer'] }],
  C: [['root']],
  M: [['A', 'B']],
});

describe('planSession', () => {
  it('resumes a node that already has a session', () => {
    expect(planSession(graph, 'A')).toEqual({ mode: 'resume', sessionId: 'SA', preamble: null, transcript: [] });
  });

  it("forks the parent's session for a new branch, with the branch note first", () => {
    expect(planSession(graph, 'C')).toEqual({
      mode: 'fork',
      sessionId: 'S0',
      preamble: branchStartNote('Title C'),
      transcript: [],
    });
  });

  it("forks the base's session for a merge node, with the results as preamble", () => {
    const plan = planSession(graph, 'M');
    expect(plan.mode).toBe('fork');
    expect(plan.sessionId).toBe('S0'); // the base, not a branch
    expect(plan.preamble).toContain('Findings: A found');
    expect(plan.preamble).toContain('Findings: B found');
    expect(plan.preamble).not.toContain('a answer');
  });

  it("a forked node goes on in a copy of its session, so its branches' fork point stays as it was", () => {
    const g = buildGraph({
      root: [[], { sessionId: 'S0', messages: ['u: q', 'a: a'] }],
      A: [['root'], { forkPoint: 2, forkSession: 'S0' }],
    });
    expect(planSession(g, 'root')).toEqual({ mode: 'fork', sessionId: 'S0', preamble: null, transcript: [] });
    expect(planSession(g, 'A')).toMatchObject({ mode: 'fork', sessionId: 'S0', preamble: branchStartNote('Title A') });
  });

  it('resumes once the forked node has its own copy, and never copies a finished node', () => {
    const g = buildGraph({
      root: [[], { sessionId: 'S1', messages: ['u: q', 'a: a', 'u: more', 'a: more'] }],
      A: [['root'], { forkPoint: 2, forkSession: 'S0', result: result('A'), sessionId: 'SA', messages: ['u: x', 'a: y'] }],
      B: [['A'], { forkPoint: 2, forkSession: 'SA' }],
    });
    expect(planSession(g, 'root')).toMatchObject({ mode: 'resume', sessionId: 'S1' });
    expect(planSession(g, 'A')).toMatchObject({ mode: 'resume', sessionId: 'SA' }); // finished: its session can't change
  });

  it('a branch whose first reply never started forks the session from its fork point, not the parent now', () => {
    const g = buildGraph({
      root: [[], { sessionId: 'S1', messages: ['u: q', 'a: a', 'u: more', 'a: more'] }],
      A: [['root'], { forkPoint: 2, forkSession: 'S0' }],
    });
    expect(planSession(g, 'A')).toMatchObject({ mode: 'fork', sessionId: 'S0' });
    // Without a session at the fork point: the parent's messages up to it, as a transcript.
    const noSession = buildGraph({
      root: [[], { messages: ['u: q', 'a: a', 'u: more', 'a: more'] }],
      A: [['root'], { forkPoint: 2 }],
    });
    expect(planSession(noSession, 'A').transcript.map((t) => t.content)).toEqual(['q', 'a']);
  });

  it('starts a new session for an empty root', () => {
    const g = buildGraph({ root: [[]] });
    expect(planSession(g, 'root')).toEqual({ mode: 'new', sessionId: null, preamble: null, transcript: [] });
  });

  it("seeds a transcript when the parent has no session (e.g. written by another provider)", () => {
    const g = buildGraph({ root: [[], { messages: ['u: hello', 'a: hi'] }], child: [['root']] });
    const plan = planSession(g, 'child');
    expect(plan.mode).toBe('new');
    expect(plan.transcript.map((t) => t.content)).toEqual(['hello', 'hi']);
    const text = firstMessage(plan, 'question');
    expect(text).toContain('User: hello');
    expect(text).toContain('Assistant: hi');
    expect(text.endsWith(`${branchStartNote('Title child')}\n\nquestion`)).toBe(true);
  });

  it('replays the whole conversation when a node has messages but no session', () => {
    const g = buildGraph({ root: [[], { messages: ['u: hello', 'a: hi'] }] });
    const plan = planSession(g, 'root');
    expect(plan).toMatchObject({ mode: 'new', preamble: null });
    expect(plan.transcript).toHaveLength(2);
  });
});
