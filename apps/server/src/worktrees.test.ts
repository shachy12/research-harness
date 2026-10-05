import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANAGED_DIR, type DagNode, type Project } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/database.ts';
import { Repository } from './db/repository.ts';
import { Workspaces } from './workspace.ts';
import { BRANCH_PREFIX, Worktrees, parseNumstat } from './worktrees.ts';

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });

let repo: Repository;
let worktrees: Worktrees;
let folder: string;
let project: Project;

/** A project whose folder is a fresh git repository with one commit (main.tex). */
function setup({ initRepo = true } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'harness-wt-data-'));
  folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-wt-proj-')));
  writeFileSync(path.join(folder, 'main.tex'), 'line one\nline two\nline three\n');
  if (initRepo) {
    gitIn(folder, 'init', '-b', 'main');
    gitIn(folder, 'config', 'core.autocrlf', 'false'); // compare files byte for byte on Windows too
    gitIn(folder, 'add', '-A');
    gitIn(folder, 'commit', '-m', 'start');
  }
  repo = new Repository(openDatabase(':memory:'));
  project = repo.createProject('p', 'Test', 'Main thread', folder);
  worktrees = new Worktrees(new Workspaces(dataDir));
}

const root = () => repo.listNodes('p').find((n) => n.parentIds.length === 0)!;

/** Make the node's copy, run `edit` in it, and commit like a reply would. */
async function work(node: DagNode, edit: (dir: string) => void) {
  const copy = await worktrees.ensure(project, repo.snapshot('p'), node);
  repo.setGitInfo(node.id, copy.branch, null);
  edit(copy.editDir);
  await worktrees.commit(project, node.id, `${node.title}: reply`);
  return copy;
}

const child = (parent: DagNode, title: string) => repo.createNode({ projectId: 'p', title, parentIds: [parent.id] });

describe('Worktrees', () => {
  beforeEach(() => setup());

  it('names branches after the managed folder, without its dot', () => {
    expect(BRANCH_PREFIX).toBe(MANAGED_DIR.replace(/^\./, ''));
    expect(Worktrees.branchOf('1234abcd-0000-0000-0000-000000000000')).toBe(`${BRANCH_PREFIX}/1234abcd`);
  });

  it('turns a plain folder into a repository with a first commit, on the branch it announced', async () => {
    setup({ initRepo: false });
    const before = await worktrees.inspect(folder);
    expect(before).toMatchObject({ repository: false, uncommitted: false });
    expect(await worktrees.setUp(project)).toBe(true);
    expect(gitIn(folder, 'ls-files').trim()).toBe('main.tex'); // .harness stays out of it
    expect(gitIn(folder, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(before.branch);
    expect(await worktrees.setUp(project)).toBe(false);
    expect(await worktrees.inspect(folder)).toEqual({ repository: true, branch: before.branch, uncommitted: false });
  });

  it('makes its own repository when the folder is ignored by an enclosing one', async () => {
    const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-wt-outer-')));
    gitIn(outer, 'init');
    writeFileSync(path.join(outer, '.gitignore'), 'data/\n');
    const inner = path.join(outer, 'data', 'proj');
    mkdirSync(inner, { recursive: true });
    expect((await worktrees.inspect(inner)).repository).toBe(false);
    const p = repo.createProject('q', 'Inner', 'Main thread', inner);
    expect(await worktrees.setUp(p)).toBe(true);
    expect(existsSync(path.join(inner, '.git'))).toBe(true);
  });

  it('reports the branch and uncommitted changes of an existing repository', async () => {
    writeFileSync(path.join(folder, 'main.tex'), 'changed\n');
    expect(await worktrees.inspect(folder)).toEqual({ repository: true, branch: 'main', uncommitted: true });
  });

  it('creates the repository at the first run if the project has none yet', async () => {
    setup({ initRepo: false });
    const copy = await worktrees.ensure(project, repo.snapshot('p'), root());
    expect(existsSync(path.join(copy.editDir, 'main.tex'))).toBe(true);
  });

  it('gives a node its own copy, commits its edits and shows them as changes', async () => {
    const copy = await work(root(), (dir) => {
      writeFileSync(path.join(dir, 'main.tex'), 'line one\nline TWO\nline three\n');
      writeFileSync(path.join(dir, 'notes.md'), 'new\n');
    });
    expect(copy.worktree).toBe(path.join(folder, MANAGED_DIR, 'work', Worktrees.shortId(root().id)));
    expect(copy.created).toBe(true);
    expect(readFileSync(path.join(folder, 'main.tex'), 'utf8')).toContain('line two'); // the project is untouched

    const changes = (await worktrees.changes(project, root().id))!;
    expect(changes.target).toBe('main');
    expect(changes.files).toEqual([
      { path: 'main.tex', status: 'modified', additions: 1, deletions: 1 },
      { path: 'notes.md', status: 'added', additions: 1, deletions: 0 },
    ]);
    expect(changes.diff).toContain('+line TWO');
    expect(changes).toMatchObject({ conflicts: [], unresolved: [], applied: false, truncated: false });
    expect((await worktrees.ensure(project, repo.snapshot('p'), root())).created).toBe(false);
  });

  it('starts a branch from its parent’s files and keeps siblings apart', async () => {
    await work(root(), (dir) => writeFileSync(path.join(dir, 'a.txt'), 'from root\n'));
    const r = root();
    const [b1, b2] = [child(r, 'B1'), child(r, 'B2')];
    await worktrees.retire(project, r.id, 'final');
    expect(existsSync(worktrees.worktreeOf(project, r.id))).toBe(false); // removed; the branch stays

    const c1 = await work(b1, (dir) => writeFileSync(path.join(dir, 'b1.txt'), 'one\n'));
    const c2 = await work(b2, () => {});
    expect(readFileSync(path.join(c1.editDir, 'a.txt'), 'utf8')).toBe('from root\n');
    expect(existsSync(path.join(c2.editDir, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(c2.editDir, 'b1.txt'))).toBe(false);
  });

  it('a forked node edits on; its branches start from its files at the fork', async () => {
    await work(root(), (dir) => writeFileSync(path.join(dir, 'a.txt'), 'at the fork\n'));
    const r = root();
    const b = child(r, 'B');
    await worktrees.fork(project, r.id, [b.id], 'forked');
    expect(existsSync(worktrees.worktreeOf(project, r.id))).toBe(true); // the parent keeps its copy

    await work(r, (dir) => writeFileSync(path.join(dir, 'a.txt'), 'after the fork\n')); // before B first runs
    const copy = await work(b, () => {});
    expect(readFileSync(path.join(copy.editDir, 'a.txt'), 'utf8')).toBe('at the fork\n');
  });

  it('merges branches into the merged node’s copy, leaving conflict markers to resolve', async () => {
    const r = root();
    const [a, b] = [child(r, 'A'), child(r, 'B')];
    await work(a, (dir) => {
      writeFileSync(path.join(dir, 'main.tex'), 'line one\nline two by A\nline three\n');
      writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    });
    await work(b, (dir) => writeFileSync(path.join(dir, 'main.tex'), 'line one\nline two by B\nline three\n'));
    const [na, nb] = [repo.getNode(a.id)!, repo.getNode(b.id)!];

    const preview = await worktrees.previewMerge(project, repo.snapshot('p'), [na.id, nb.id]);
    expect(preview.conflicts).toEqual(['main.tex']);
    expect(preview.branches.map((x) => [x.title, x.files])).toEqual([['A', ['a.txt', 'main.tex']], ['B', ['main.tex']]]);

    const m = repo.createNode({ projectId: 'p', title: 'M', parentIds: [na.id, nb.id] });
    const copy = await worktrees.ensure(project, repo.snapshot('p'), m);
    expect(copy.conflicts).toEqual(['main.tex']);
    expect(copy.merged.map((x) => x.title)).toEqual(['A', 'B']);
    const text = readFileSync(path.join(copy.editDir, 'main.tex'), 'utf8');
    expect(text).toContain('<<<<<<<');
    expect(text).toContain('line two by A');
    expect(text).toContain('line two by B');
    expect(readFileSync(path.join(copy.editDir, 'a.txt'), 'utf8')).toBe('a\n');
    repo.setGitInfo(m.id, copy.branch, null);
    expect((await worktrees.changes(project, m.id))!.unresolved).toEqual(['main.tex']);
  });

  it('applies a branch to the project’s branch', async () => {
    await work(root(), (dir) => writeFileSync(path.join(dir, 'notes.md'), 'new\n'));
    expect(await worktrees.apply(project, root().id, 'Main thread')).toEqual({ ok: true });
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('new\n');
    const changes = (await worktrees.changes(project, root().id))!;
    expect(changes.applied).toBe(true);
    expect(changes.files).toEqual([]);
  });

  it('refuses to apply over conflicting project changes and leaves the folder as it was', async () => {
    await work(root(), (dir) => writeFileSync(path.join(dir, 'main.tex'), 'line one\nbranch\nline three\n'));
    writeFileSync(path.join(folder, 'main.tex'), 'line one\nuser\nline three\n');
    gitIn(folder, 'commit', '-am', 'user edit');

    expect((await worktrees.changes(project, root().id))!.conflicts).toEqual(['main.tex']);
    const result = await worktrees.apply(project, root().id, 'Main thread');
    expect(result).toMatchObject({ ok: false, conflicts: ['main.tex'] });
    expect(readFileSync(path.join(folder, 'main.tex'), 'utf8')).toBe('line one\nuser\nline three\n');
    expect(gitIn(folder, 'status', '--porcelain').trim()).toBe('');
  });

  it('has no changes for a node without a branch', async () => {
    expect(await worktrees.changes(project, root().id)).toBeNull();
  });
});

describe('parseNumstat', () => {
  it('reads changed, added, binary and renamed files', () => {
    const numstat = '3\t1\ta.tex\0-\t-\tfig.png\0' + '0\t0\t\0old.txt\0new.txt\0';
    const nameStatus = 'M\0a.tex\0A\0fig.png\0R100\0old.txt\0new.txt\0';
    expect(parseNumstat(numstat, nameStatus)).toEqual([
      { path: 'a.tex', status: 'modified', additions: 3, deletions: 1 },
      { path: 'fig.png', status: 'added', additions: null, deletions: null },
      { path: 'new.txt', status: 'renamed', additions: 0, deletions: 0 },
    ]);
  });
});
