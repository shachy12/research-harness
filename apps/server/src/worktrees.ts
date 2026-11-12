import { type Dirent, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DagNode, type FileChange, type FolderGit, type GitBranches, MANAGED_DIR, type MergePreview, type NodeChanges, type NodeFiles, type Project } from '@harness/shared';
import type { GraphReader } from './dag/graph.ts';
import { type GitOutput, KeyedQueue, commitArgs, git, gitBytes, identityArgs, runGit } from './git.ts';
import type { Workspaces } from './workspace.ts';

/** Prefix of Harness's branches: the managed folder's name without its dot (git refuses `.harness/…`). */
export const BRANCH_PREFIX = MANAGED_DIR.replace(/^\.+/, '') || 'harness';

/** The largest diff sent to the page; bigger ones are cut (the file list stays complete). */
const MAX_DIFF_CHARS = 400_000;

/** The most files the Files view lists. */
const MAX_LISTED_FILES = 10_000;


/** Where a project's files live in git. */
interface RepoInfo {
  /** The repository's top folder (the project folder, or a folder above it). */
  top: string;
  /** The project folder relative to `top` ('' when they are the same). */
  rel: string;
}

/**
 * Settings for every git command Harness runs in a node's copy. The copy's files may have been
 * written by a model (in the sandbox: by untrusted code), so nothing in them may make git run a
 * program: no file system monitor, and no recursing into nested repositories (git would run
 * itself there, with that repository's config).
 */
const COPY_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false'];

/**
 * git in one node's copy. Every command names the copy's git folder (in the repository's
 * `.git/worktrees/`) explicitly, so the `.git` file inside the copy, which the model can rewrite
 * (e.g. to point at a folder with its own config), is never read.
 */
interface CopyGit {
  /** The copy's git folder (`.git/worktrees/<name>` of the project's repository). */
  admin: string;
  run(args: string[], options?: { cwd?: string; input?: string; env?: Record<string, string> }): Promise<GitOutput>;
  git(args: string[], options?: { cwd?: string; input?: string; env?: Record<string, string> }): Promise<string>;
  /** Identity and no signing, from the repository's own config (see `commitArgs`). */
  commitArgs: string[];
}

/** A node's editable copy, ready for a run. */
export interface NodeWorktree {
  branch: string;
  /** The worktree's top folder. */
  worktree: string;
  /** The project folder inside the worktree: where the model may edit. */
  editDir: string;
  /** The worktree was created for this run (the model hasn't been told about it yet). */
  created: boolean;
  /** The copy's git folder (`.git/worktrees/<name>`), and the repository's (both stay read-only in the sandbox). */
  gitAdmin: string;
  gitCommon: string;
  /** For a merge node: what each merged branch changed, and files left with conflict markers. */
  merged: { title: string; files: string[] }[];
  conflicts: string[];
  /**
   * A branch whose copy started from the project's branch (its target branch, else the checked-out
   * one) instead of its parent's files (`DagNode.filesFromProject`): that branch's name (or the
   * commit, on a detached HEAD).
   */
  fromProject: string | null;
}

/**
 * File editing with one git worktree per node.
 *
 * Each node that runs (with a provider that can edit) gets its own branch `harness/<id>` and a
 * worktree at `<folder>/.harness/work/<id>/`, started from where its parent's files were (a merge
 * node: its branches merged together; the root: the user's current commit). The model edits only
 * there. Its changes are committed after every reply, so a forked node's files are fixed like its
 * conversation, and children start from them. The user sees the diff and applies it to their own
 * branch with a separate step.
 *
 * The project folder stays the model's working folder (Claude Code sessions belong to a folder),
 * so the model reads the project there and edits its copy under `.harness/work/`.
 */
export class Worktrees {
  private readonly workspaces: Workspaces;
  private readonly queue = new KeyedQueue();

  constructor(workspaces: Workspaces) {
    this.workspaces = workspaces;
  }

  /** Short id used in branch and folder names (full uuids make Windows paths too long). */
  static shortId(nodeId: string): string {
    return nodeId.replace(/-/g, '').slice(0, 8);
  }

  static branchOf(nodeId: string): string {
    return `${BRANCH_PREFIX}/${Worktrees.shortId(nodeId)}`;
  }

  worktreeOf(project: Project, nodeId: string): string {
    return path.join(this.workspaces.managedOf(project), 'work', Worktrees.shortId(nodeId));
  }

  /**
   * What happens to a folder chosen for a new project, for the dialog's notice: whether it is a git
   * repository (one that ignores the folder doesn't count; the folder then gets its own), its
   * current branch (or the one `git init` will create), and whether it has uncommitted changes.
   */
  async inspect(folder: string): Promise<FolderGit> {
    const repo = await this.findRepo(folder);
    if (!repo) return { repository: false, branch: await this.initialBranch(folder), uncommitted: false };
    const branch = (await runGit(repo.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
    const status = await git(folder, ['status', '--porcelain', '--', '.']);
    return { repository: true, branch, uncommitted: status.trim() !== '' };
  }

  /**
   * Make the project's folder a git repository if it isn't one, with a first commit of the files in
   * it (the project's own `.harness/` stays out). Done when the project is created; projects from
   * before get it on their first run. Returns whether a repository was created.
   */
  setUp(project: Project): Promise<boolean> {
    const folder = this.workspaces.prepare(project);
    return this.queue.run(folder, async () => {
      if (await this.findRepo(folder)) return false;
      await this.initRepo(folder);
      return true;
    });
  }

  /**
   * Make sure the node has its branch and worktree, creating them if needed. Its start: the
   * parent's branch (a merge node: the merged branches' branches, merged; conflicts are committed
   * with their markers for the model to resolve), or the nearest ancestor's, or the user's commit.
   */
  ensure(project: Project, graph: GraphReader, node: DagNode): Promise<NodeWorktree> {
    const folder = this.workspaces.prepare(project);
    return this.queue.run(folder, async () => {
      const repo = (await this.findRepo(folder)) ?? (await this.initRepo(folder));
      const branch = Worktrees.branchOf(node.id);
      const worktree = this.worktreeOf(project, node.id);
      const result = async (created: boolean, merged: NodeWorktree['merged'] = [], conflicts: string[] = [], fromProject: string | null = null): Promise<NodeWorktree> => {
        const copy = await this.copyGit(repo.top, worktree);
        if (!copy) throw new Error(`git doesn't know the copy at ${worktree} (its folder in .git/worktrees is missing).`);
        return {
          branch, worktree, editDir: path.join(worktree, repo.rel), created, merged, conflicts, fromProject,
          gitAdmin: copy.admin, gitCommon: await this.commonDir(repo.top),
        };
      };

      if (existsSync(path.join(worktree, '.git'))) return result(false);
      mkdirSync(path.dirname(worktree), { recursive: true });
      if (await this.branchExists(repo.top, branch)) {
        await git(repo.top, ['worktree', 'prune']);
        await git(repo.top, ['worktree', 'add', worktree, branch]);
        return result(false);
      }

      // A branch asked to start from the project's files: the tip of its target branch (else the
      // user's current commit) as it is now.
      if (node.filesFromProject && node.parentIds.length === 1) {
        const name = await this.targetName(repo.top, node.targetBranch);
        const commit = await this.targetCommit(repo.top, node.targetBranch);
        await git(repo.top, ['worktree', 'prune']);
        await git(repo.top, ['worktree', 'add', '-b', branch, worktree, commit]);
        return result(true, [], [], name || commit.slice(0, 10));
      }

      // The merged nodes' copies may hold changes the user made there (in VS Code) since their last reply.
      if (node.parentIds.length > 1) {
        for (const id of node.parentIds) await this.commitCopy(folder, this.worktreeOf(project, id), 'Saved before a merge');
      }
      // Named like the merged results in the prompt (by the title they were created with).
      const starts = node.parentIds.map((id) => ({ title: graph.node(id).promptTitle, ref: this.startOf(graph, id) }));
      // A root (or a line with no branch yet) starts from its target branch's tip as it is now, so
      // whatever was applied to that branch before is in it.
      const first = starts.find((s) => s.ref)?.ref ?? (await this.targetCommit(repo.top, node.targetBranch));
      await git(repo.top, ['worktree', 'prune']); // forget worktrees whose folders were deleted by hand
      await git(repo.top, ['worktree', 'add', '-b', branch, worktree, first]);

      // A merge node: merge the other branches in, one at a time.
      const merged: NodeWorktree['merged'] = [];
      const conflicts = new Set<string>();
      if (node.parentIds.length > 1) {
        const copy = (await this.copyGit(repo.top, worktree))!;
        const refs = [...new Set(starts.flatMap((s) => (s.ref ? [s.ref] : [])))];
        const base = refs.length > 1 ? (await git(repo.top, ['merge-base', '--octopus', ...refs])).trim() : first;
        for (const { title, ref } of starts) {
          if (ref) merged.push({ title, files: await this.changedFiles(repo.top, base, ref) });
          if (!ref || ref === first) continue;
          const out = await copy.run([...copy.commitArgs, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', `Merge "${title}"`, ref]);
          if (out.code === 0) continue;
          const unmerged = (await copy.git(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
          if (unmerged.length === 0) throw new Error(`Could not merge the files of "${title}": ${out.stderr.trim()}`);
          unmerged.forEach((f) => conflicts.add(f));
          await copy.git(['add', '-A']);
          await copy.git([...copy.commitArgs, 'commit', '--no-edit', '--no-verify', '-m', `Merge "${title}" (conflicts left in ${unmerged.join(', ')})`]);
        }
      }
      return result(true, merged, [...conflicts]);
    });
  }

  /** Commit whatever the model changed in the node's worktree. Returns whether anything was committed. */
  commit(project: Project, nodeId: string, message: string): Promise<boolean> {
    const folder = this.workspaces.folderOf(project);
    return this.queue.run(folder, () => this.commitCopy(folder, this.worktreeOf(project, nodeId), message));
  }

  /**
   * After a sandboxed reply: undo what could make host programs run code from the copy. The
   * copy's `.git` file gets its proper content back (VS Code and the user's own git read it), and
   * git folders the model made inside the copy (nested repositories: their config could run
   * programs once git or VS Code looks at them) are removed. Their files stay. Returns the paths
   * removed, relative to the copy.
   */
  scrub(project: Project, nodeId: string): Promise<string[]> {
    const folder = this.workspaces.folderOf(project);
    const worktree = this.worktreeOf(project, nodeId);
    return this.queue.run(folder, async () => {
      const repo = await this.findRepo(folder);
      if (!repo || !existsSync(worktree)) return [];
      const copy = await this.copyGit(repo.top, worktree);
      if (!copy) return [];
      const dotGit = path.join(worktree, '.git');
      const expected = `gitdir: ${copy.admin.split(path.sep).join('/')}\n`;
      let current: string | null = null;
      try {
        current = lstatSync(dotGit).isFile() ? readFileSync(dotGit, 'utf8') : null;
      } catch {
        // missing
      }
      if (current?.trim() !== expected.trim()) {
        rmSync(dotGit, { recursive: true, force: true });
        writeFileSync(dotGit, expected);
      }
      return removeNestedGit(worktree);
    });
  }

  /**
   * A node was forked and goes on: commit its copy and start each branch's git branch where it is
   * now, so the branches get the files as they were at the fork even if the parent edits on
   * before they first run. (A branch's worktree is still made at its first run, by `ensure`.)
   */
  fork(project: Project, parentId: string, childIds: string[], message: string): Promise<void> {
    const folder = this.workspaces.folderOf(project);
    return this.queue.run(folder, async () => {
      await this.commitCopy(folder, this.worktreeOf(project, parentId), message);
      const repo = await this.findRepo(folder);
      const from = Worktrees.branchOf(parentId);
      if (!repo || !(await this.branchExists(repo.top, from))) return;
      for (const id of childIds) {
        const branch = Worktrees.branchOf(id);
        if (!(await this.branchExists(repo.top, branch))) await git(repo.top, ['branch', branch, from]);
      }
    });
  }

  /**
   * The files of the node's copy, for the Files view. Before its first reply a node has no copy:
   * then its branch (a forked node has one already), or the files it will start from.
   */
  files(project: Project, graph: GraphReader, node: DagNode): Promise<NodeFiles> {
    const folder = this.workspaces.prepare(project); // a new project's folder may not exist yet
    return this.queue.run(folder, async () => {
      const source = await this.sourceOf(project, graph, node);
      if (!source) return { source: 'start', folder: null, files: [], inRepo: '', truncated: false };
      let files: string[];
      if (source.dir !== null) {
        const copy = await this.copyGit(source.repo.top, this.worktreeOf(project, node.id));
        if (!copy) return { source: 'start', folder: null, files: [], inRepo: '', truncated: false };
        const listed = await copy.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source.dir });
        // Tracked files deleted in the copy are still in git's index: list only what is there.
        files = [...new Set(listed.split('\0').filter(Boolean))].filter((f) => existsSync(path.join(source.dir!, f)));
      } else {
        files = (await git(folder, ['ls-tree', '-r', '-z', '--name-only', source.ref])).split('\0').filter(Boolean);
      }
      files.sort(comparePaths);
      return {
        source: source.kind,
        folder: source.dir === null ? null : path.resolve(source.dir),
        files: files.slice(0, MAX_LISTED_FILES),
        inRepo: source.repo.rel.split(path.sep).join('/'),
        truncated: files.length > MAX_LISTED_FILES,
      };
    });
  }

  /**
   * One file of the node's copy (as the Files view lists it): its size, and its bytes if it is no
   * larger than `maxBytes`. Null if there is no such file.
   */
  readFile(project: Project, graph: GraphReader, node: DagNode, file: string, maxBytes: number): Promise<{ size: number; bytes: Buffer | null } | null> {
    const folder = this.workspaces.prepare(project);
    const rel = safeRelativePath(file);
    if (!rel) return Promise.resolve(null);
    return this.queue.run(folder, async () => {
      const source = await this.sourceOf(project, graph, node);
      if (!source) return null;
      if (source.dir !== null) {
        const full = path.join(source.dir, rel);
        if (!existsSync(full)) return null;
        // A link must not lead outside the copy.
        const real = realpathSync(full);
        const inside = path.relative(realpathSync(source.dir), real);
        if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
        const stat = statSync(real);
        if (!stat.isFile()) return null;
        return { size: stat.size, bytes: stat.size <= maxBytes ? readFileSync(real) : null };
      }
      const object = `${source.ref}:./${rel}`;
      const type = await runGit(folder, ['cat-file', '-t', object]);
      if (type.code !== 0 || type.stdout.trim() !== 'blob') return null;
      const size = Number((await git(folder, ['cat-file', '-s', object])).trim());
      return { size, bytes: size <= maxBytes ? await gitBytes(folder, ['cat-file', 'blob', object]) : null };
    });
  }

  /** Where the node's files are read from: its copy's project folder, or else a commit (see `files`). */
  private async sourceOf(project: Project, graph: GraphReader, node: DagNode): Promise<
    | { kind: 'copy'; repo: RepoInfo; dir: string; ref: null }
    | { kind: 'branch' | 'start'; repo: RepoInfo; dir: null; ref: string }
    | null
  > {
    const repo = await this.findRepo(this.workspaces.folderOf(project));
    if (!repo) return null;
    const worktree = this.worktreeOf(project, node.id);
    if (existsSync(path.join(worktree, '.git'))) return { kind: 'copy', repo, dir: path.join(worktree, repo.rel), ref: null };
    const branch = Worktrees.branchOf(node.id);
    if (await this.branchExists(repo.top, branch)) return { kind: 'branch', repo, dir: null, ref: `refs/heads/${branch}` };
    const start = node.filesFromProject ? null : this.startOf(graph, node.id);
    return { kind: 'start', repo, dir: null, ref: start ? `refs/heads/${start}` : await this.targetCommit(repo.top, node.targetBranch) };
  }

  /**
   * The node's copy as it is on disk, as a commit on top of its branch (not on any branch, so git
   * cleans it up later); the branch itself when nothing is uncommitted. Built with a temporary
   * index, so the copy's own index, HEAD and branch stay untouched: the model may be using git
   * there meanwhile.
   */
  private async onDisk(top: string, worktree: string, branch: string): Promise<string> {
    if (!existsSync(path.join(worktree, '.git'))) return branch;
    const copy = await this.copyGit(top, worktree);
    if (!copy) return branch;
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-index-'));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
      // Start from a copy of the copy's index: its file times let `git add` skip unchanged files.
      const index = path.join(copy.admin, 'index');
      if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
      else await copy.git(['read-tree', branch], { env });
      await copy.git(['add', '-A'], { env });
      const tree = (await copy.git(['write-tree'], { env })).trim();
      if (tree === (await copy.git(['rev-parse', `${branch}^{tree}`])).trim()) return branch;
      return (await copy.git([...copy.commitArgs, 'commit-tree', tree, '-p', branch, '-m', 'Uncommitted changes'])).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async commitCopy(folder: string, worktree: string, message: string): Promise<boolean> {
    if (!existsSync(path.join(worktree, '.git'))) return false;
    const repo = await this.findRepo(folder);
    const copy = repo && (await this.copyGit(repo.top, worktree));
    if (!copy) return false;
    await copy.git(['add', '-A']);
    if ((await copy.run(['diff', '--cached', '--quiet'])).code === 0) return false;
    await copy.git([...copy.commitArgs, 'commit', '--no-verify', '-m', message]);
    return true;
  }

  /** The repository's git folder (`.git`, or wherever a `.git` file at its top points). */
  private async commonDir(top: string): Promise<string> {
    const out = (await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return path.resolve(out);
  }

  /**
   * git for a node's copy (see `CopyGit`), or null if the repository has no worktree there. The
   * copy's git folder is found from the repository's side: the `.git/worktrees/<name>/gitdir`
   * file that points back at the copy (written by git, out of the model's reach).
   */
  private async copyGit(top: string, worktree: string): Promise<CopyGit | null> {
    const common = await this.commonDir(top);
    const want = normalizePath(path.join(worktree, '.git'));
    const list = path.join(common, 'worktrees');
    let admin: string | null = null;
    for (const name of existsSync(list) ? readdirSync(list) : []) {
      try {
        const target = readFileSync(path.join(list, name, 'gitdir'), 'utf8').trim();
        if (normalizePath(path.resolve(list, name, target)) === want) {
          admin = path.join(list, name);
          break;
        }
      } catch {
        // not a worktree folder
      }
    }
    if (!admin) return null;
    const found = admin;
    const prefix = ['--git-dir', found, '--work-tree', worktree, ...COPY_SAFETY];
    const commit = await commitArgs(top);
    return {
      admin: found,
      run: (args, o = {}) => runGit(o.cwd ?? worktree, [...prefix, ...args], o.input, o.env),
      git: (args, o = {}) => git(o.cwd ?? worktree, [...prefix, ...args], o.input, o.env),
      commitArgs: commit,
    };
  }

  /**
   * Node folders are never removed (their files stay viewable). Earlier versions removed them when
   * a node was finished (before 2026-10-06) or deleted (before 2026-10-09): bring such a folder
   * back from the node's branch. Returns whether the node has its folder now.
   */
  restore(project: Project, nodeId: string): Promise<boolean> {
    const folder = this.workspaces.prepare(project);
    const worktree = this.worktreeOf(project, nodeId);
    return this.queue.run(folder, async () => {
      if (existsSync(path.join(worktree, '.git'))) return true;
      const repo = await this.findRepo(folder);
      const branch = Worktrees.branchOf(nodeId);
      if (!repo || !(await this.branchExists(repo.top, branch))) return false;
      mkdirSync(path.dirname(worktree), { recursive: true });
      await git(repo.top, ['worktree', 'prune']);
      await git(repo.top, ['worktree', 'add', worktree, branch]);
      return true;
    });
  }

  /**
   * What applying the node's branch would bring into its target branch (`targetBranch`, else the
   * user's current branch): changed files, the diff, and conflicts. `null` when the node has no
   * branch. Edits in its copy that aren't committed yet count too (a reply still running, or the
   * user's edits in VS Code): Apply commits them first.
   */
  changes(project: Project, nodeId: string, targetBranch: string | null = null): Promise<NodeChanges | null> {
    const folder = this.workspaces.folderOf(project);
    const branch = Worktrees.branchOf(nodeId);
    return this.queue.run(folder, async () => {
      const repo = await this.findRepo(folder);
      if (!repo || !(await this.branchExists(repo.top, branch))) return null;
      const target = await this.targetName(repo.top, targetBranch);
      const base = await this.targetCommit(repo.top, targetBranch);
      const head = await this.onDisk(repo.top, this.worktreeOf(project, nodeId), branch);
      const range = `${base}...${head}`;
      const files = parseNumstat(
        await git(repo.top, ['diff', '--numstat', '-z', '-M', range]),
        await git(repo.top, ['diff', '--name-status', '-z', '-M', range]),
      );
      const full = await git(repo.top, ['diff', '-M', range]);
      const applied = (await runGit(repo.top, ['merge-base', '--is-ancestor', head, base])).code === 0;
      const conflicts = applied ? [] : await this.conflictsWith(repo.top, base, head);
      // Changed files that still hold merge conflict markers (a merge the model hasn't resolved yet).
      const changed = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
      const markers = changed.length === 0 ? '' : (await runGit(repo.top, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', head, '--', ...changed])).stdout;
      return {
        branch,
        target,
        files,
        unresolved: markers.split('\n').filter(Boolean).map((l) => l.slice(head.length + 1)),
        diff: full.slice(0, MAX_DIFF_CHARS),
        truncated: full.length > MAX_DIFF_CHARS,
        conflicts,
        applied,
      };
    });
  }

  /** How many files the node's branch changes compared with its target branch (null: no branch). */
  async countChanges(project: Project, nodeId: string, targetBranch: string | null = null): Promise<number | null> {
    const changes = await this.changes(project, nodeId, targetBranch);
    return changes ? changes.files.length : null;
  }

  /**
   * Merge the node's branch into its target branch (`targetBranch`, else the project folder's
   * current branch). Where that branch is checked out (the project folder, or another worktree of
   * the user's) the merge runs there; on conflicts it aborts, so the folder is left as it was. A
   * branch that isn't checked out anywhere gets the merge commit directly (`git merge-tree`), so
   * no folder changes. Refuses on a detached HEAD.
   */
  apply(project: Project, nodeId: string, title: string, targetBranch: string | null = null): Promise<ApplyOutcome> {
    const folder = this.workspaces.folderOf(project);
    const branch = Worktrees.branchOf(nodeId);
    return this.queue.run(folder, async () => {
      const repo = await this.requireRepo(folder);
      if (!(await this.branchExists(repo.top, branch))) return { ok: false, error: 'This node has no file changes.', conflicts: [] };
      const message = `Apply Harness branch "${title}" (${branch})`;
      if (targetBranch === null) {
        const head = (await runGit(repo.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
        if (!head) return { ok: false, error: 'The project folder is not on a branch (detached HEAD). Check out a branch first.', conflicts: [] };
        return this.mergeIn(repo.top, branch, message);
      }
      if (!(await this.branchExists(repo.top, targetBranch))) {
        return { ok: false, error: `The branch "${targetBranch}" no longer exists in the project's repository.`, conflicts: [] };
      }
      const checkedOut = await this.checkedOutAt(repo.top, targetBranch);
      if (checkedOut) return this.mergeIn(checkedOut, branch, message);

      // Not checked out anywhere: build the merge commit without a folder and move the branch to it.
      const ref = `refs/heads/${targetBranch}`;
      const old = (await git(repo.top, ['rev-parse', ref])).trim();
      if ((await runGit(repo.top, ['merge-base', '--is-ancestor', branch, old])).code === 0) return { ok: true };
      const out = await runGit(repo.top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', old, branch]);
      const [tree, ...files] = out.stdout.split('\n').filter(Boolean);
      if (out.code === 1) {
        return { ok: false, error: `Applying would conflict with "${targetBranch}" in ${files.join(', ')}. Nothing was changed.`, conflicts: files };
      }
      if (out.code !== 0) return { ok: false, error: `Git could not apply the changes:\n${out.stderr.trim()}`, conflicts: [] };
      // The user's own identity (their branch, their commit).
      const commit = (await git(repo.top, [...(await identityArgs(repo.top)), 'commit-tree', tree, '-p', old, '-p', branch, '-m', message])).trim();
      await git(repo.top, ['update-ref', '-m', message, ref, commit, old]);
      return { ok: true };
    });
  }

  /** `git merge` of a Harness branch in a checked-out folder; on conflicts it aborts and reports them. */
  private async mergeIn(cwd: string, branch: string, message: string): Promise<ApplyOutcome> {
    // The user's own identity and signing settings (their branch, their commit).
    const out = await runGit(cwd, [...(await identityArgs(cwd)), 'merge', '--no-ff', '--no-edit', '-m', message, branch]);
    if (out.code === 0) return { ok: true };
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    if (conflicts.length > 0) {
      await runGit(cwd, ['merge', '--abort']);
      return { ok: false, error: `Applying would conflict with your changes in ${conflicts.join(', ')}. Nothing was changed.`, conflicts };
    }
    const detail = (out.stderr || out.stdout).trim().split('\n').filter(Boolean).slice(0, 6).join('\n');
    return { ok: false, error: `Git could not apply the changes:\n${detail}`, conflicts: [] };
  }

  /** The folder (a worktree of the repository) where the branch is checked out, if any. */
  private async checkedOutAt(top: string, branch: string): Promise<string | null> {
    const list = await git(top, ['worktree', 'list', '--porcelain']);
    for (const block of list.split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (at && lines.includes(`branch refs/heads/${branch}`)) return path.resolve(at);
    }
    return null;
  }

  /**
   * The repository's own branches a root can work against (Harness's `harness/…` branches left
   * out), most recently committed first, and the one the project folder has checked out.
   */
  branches(project: Project): Promise<GitBranches> {
    const folder = this.workspaces.prepare(project);
    return this.queue.run(folder, async () => {
      const repo = await this.findRepo(folder);
      if (!repo) return { current: null, branches: [] };
      const current = (await runGit(repo.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
      const all = await git(repo.top, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']);
      const branches = all.split('\n').map((b) => b.trim()).filter((b) => b && !isHarnessBranch(b));
      return { current, branches };
    });
  }

  /**
   * Make sure the branch exists for a new root: an existing branch is used as it is; a new one is
   * created at `from` (a branch), else at the project folder's current commit. Returns its name.
   */
  createBranch(project: Project, name: string, from: string | null): Promise<string> {
    const folder = this.workspaces.prepare(project);
    return this.queue.run(folder, async () => {
      const repo = (await this.findRepo(folder)) ?? (await this.initRepo(folder));
      if (isHarnessBranch(name)) throw new BranchError(`Branches starting with "${BRANCH_PREFIX}/" belong to Harness's nodes. Pick another name.`);
      if (name.startsWith('-') || name.includes('@{') || (await runGit(repo.top, ['check-ref-format', '--branch', name])).code !== 0) {
        throw new BranchError(`"${name}" is not a valid git branch name.`);
      }
      if (await this.branchExists(repo.top, name)) return name;
      let start: string;
      if (from) {
        if (!(await this.branchExists(repo.top, from))) throw new BranchError(`There is no branch "${from}" to start "${name}" from.`);
        start = `refs/heads/${from}`;
      } else {
        start = await this.userCommit(repo.top);
      }
      await git(repo.top, ['branch', name, start]);
      return name;
    });
  }

  /**
   * What merging these nodes would do to the files, without changing anything: each branch's
   * changed files and the files that would get conflict markers. Merges the same way as `ensure`
   * (in parent order), in memory with `git merge-tree`.
   */
  previewMerge(project: Project, graph: GraphReader, parentIds: string[]): Promise<MergePreview> {
    const folder = this.workspaces.folderOf(project);
    return this.queue.run(folder, async () => {
      const repo = await this.findRepo(folder);
      const starts = parentIds.map((id) => ({ nodeId: id, title: graph.node(id).title, ref: this.startOf(graph, id) }));
      const refs = [...new Set(starts.flatMap((s) => (s.ref ? [s.ref] : [])))];
      if (!repo || refs.length === 0) return { branches: [], conflicts: [] };
      const base = refs.length > 1 ? (await git(repo.top, ['merge-base', '--octopus', ...refs])).trim() : refs[0];
      const branches = [];
      for (const s of starts) {
        if (s.ref) branches.push({ nodeId: s.nodeId, title: s.title, files: await this.changedFiles(repo.top, base, s.ref) });
      }

      // Merge in order; a step with conflicts continues from its tree (markers included), like `ensure`.
      const conflicts = new Set<string>();
      let current = (await git(repo.top, ['rev-parse', refs[0]])).trim();
      for (const ref of refs.slice(1)) {
        const out = await runGit(repo.top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', current, ref]);
        if (out.code !== 0 && out.code !== 1) throw new Error(`git merge-tree failed: ${out.stderr.trim()}`);
        const [tree, ...files] = out.stdout.split('\n').filter(Boolean);
        files.forEach((f) => conflicts.add(f));
        current = (await git(repo.top, [...(await commitArgs(repo.top)), 'commit-tree', tree, '-p', current, '-p', ref, '-m', 'merge preview'])).trim();
      }
      return { branches, conflicts: [...conflicts] };
    });
  }

  // ---- helpers ----

  /**
   * Where to start a node's branch from: the nearest node up the first-parent line that has a
   * branch. A node that starts from the project's files (and has no branch yet) ends the search:
   * null means the user's current commit.
   */
  private startOf(graph: GraphReader, nodeId: string): string | null {
    for (let id: string | undefined = nodeId; id; id = graph.node(id).parentIds[0]) {
      const node = graph.node(id);
      if (node.gitBranch) return node.gitBranch;
      if (node.filesFromProject) return null;
    }
    return null;
  }

  private async changedFiles(top: string, from: string, to: string): Promise<string[]> {
    return (await git(top, ['diff', '--name-only', from, to])).split('\n').filter(Boolean);
  }

  private async conflictsWith(top: string, base: string, branch: string): Promise<string[]> {
    const out = await runGit(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch]);
    if (out.code === 0) return [];
    if (out.code !== 1) return []; // older git or another problem: no conflict check
    return out.stdout.split('\n').slice(1).filter(Boolean);
  }

  private async branchExists(top: string, branch: string): Promise<boolean> {
    return (await runGit(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  }

  /** The branch a node works against: its `targetBranch`, else the checked-out one (null: detached HEAD). */
  private async targetName(top: string, targetBranch: string | null): Promise<string | null> {
    return targetBranch ?? ((await runGit(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null);
  }

  /** The tip of the node's target branch now; without one, the user's current commit. */
  private async targetCommit(top: string, targetBranch: string | null): Promise<string> {
    if (targetBranch === null) return this.userCommit(top);
    const out = await runGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}^{commit}`]);
    if (out.code !== 0) throw new Error(`The branch "${targetBranch}" no longer exists in the project's repository.`);
    return out.stdout.trim();
  }

  /** The user's current commit, or for a repository without commits, an empty commit to start from. */
  private async userCommit(top: string): Promise<string> {
    const head = await runGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code === 0) return head.stdout.trim();
    const emptyTree = (await git(top, ['mktree'], '')).trim();
    return (await git(top, [...(await commitArgs(top)), 'commit-tree', emptyTree, '-m', 'Empty start'])).trim();
  }

  private async requireRepo(folder: string): Promise<RepoInfo> {
    const repo = await this.findRepo(folder);
    if (!repo) throw new Error('The project folder is not a git repository.');
    return repo;
  }

  /** `git init` with the branch name the new-project notice showed, and a first commit of everything. */
  private async initRepo(folder: string): Promise<RepoInfo> {
    await git(folder, ['init', '-b', await this.initialBranch(folder)]);
    await git(folder, ['add', '-A']);
    await git(folder, [...(await commitArgs(folder)), 'commit', '--allow-empty', '--no-verify', '-m', 'Start of the Harness project']);
    return { top: path.resolve(folder), rel: '' };
  }

  /** The first branch `git init` makes: the user's `init.defaultBranch`, else git's own default. */
  private async initialBranch(folder: string): Promise<string> {
    return (await runGit(folder, ['config', '--get', 'init.defaultBranch'])).stdout.trim() || 'master';
  }

  /** The repository holding the folder, unless there is none or it ignores the folder. */
  private async findRepo(folder: string): Promise<RepoInfo | null> {
    const out = await runGit(folder, ['rev-parse', '--show-toplevel']);
    if (out.code !== 0) return null;
    const top = path.resolve(out.stdout.trim());
    const rel = path.relative(top, path.resolve(folder));
    if (rel && (await runGit(top, ['check-ignore', '--quiet', '--', rel])).code === 0) return null;
    return { top, rel };
  }
}

export type ApplyOutcome = { ok: true } | { ok: false; error: string; conflicts: string[] };

/** A branch name the user can't use for a root (invalid, or one of Harness's own); shown as is. */
export class BranchError extends Error {}

/** One of Harness's own node branches (`harness/<id>`). */
export function isHarnessBranch(name: string): boolean {
  return name.startsWith(`${BRANCH_PREFIX}/`);
}

/** A path for comparing: absolute, and on Windows case-insensitive with one kind of slash. */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase().replaceAll('/', '\\') : resolved;
}

/**
 * Remove every `.git` (folder or file) inside a copy except its own top-level `.git` file.
 * Links are not followed. Returns the removed paths, relative to the copy.
 */
export function removeNestedGit(top: string): string[] {
  const removed: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase() === '.git') {
        if (dir === top) continue;
        rmSync(full, { recursive: true, force: true });
        removed.push(path.relative(top, full).split(path.sep).join('/'));
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
      }
    }
  };
  walk(top);
  return removed;
}

/** Folders before files, then by name (case-insensitive), level by level: the order of a file tree. */
export function comparePaths(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return pa[i].localeCompare(pb[i], undefined, { sensitivity: 'base', numeric: true }) || (pa[i] < pb[i] ? -1 : 1);
  }
  return pa.length - pb.length;
}

/**
 * A path the page asked for, made safe to join to a copy's folder: relative, '/'-separated, no
 * `..`, nothing inside `.git`. Null if it isn't one.
 */
export function safeRelativePath(file: string): string | null {
  if (file.includes('\0') || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return null;
  const parts = file.replaceAll('\\', '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..' || p.toLowerCase() === '.git')) return null;
  return parts.join('/');
}

/** Combine `git diff --numstat -z` and `--name-status -z` into one entry per file. */
export function parseNumstat(numstat: string, nameStatus: string): FileChange[] {
  const statuses: { status: FileChange['status']; path: string }[] = [];
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length - 1;) {
    const code = ns[i++];
    if (code.startsWith('R') || code.startsWith('C')) {
      i++; // old path
      statuses.push({ status: 'renamed', path: ns[i++] });
    } else {
      statuses.push({ status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', path: ns[i++] });
    }
  }

  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length - 1;) {
    const [add, del, name] = parts[i++].split('\t');
    let file = name;
    if (name === '') {
      i++; // a rename: old path, then new path
      file = parts[i++];
    }
    counts.set(file, { additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) });
  }

  return statuses.map((s) => ({ ...s, ...(counts.get(s.path) ?? { additions: null, deletions: null }) }));
}
