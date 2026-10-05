import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { type DagNode, type FileChange, type FolderGit, MANAGED_DIR, type MergePreview, type NodeChanges, type Project } from '@harness/shared';
import type { GraphReader } from './dag/graph.ts';
import { HARNESS_COMMIT_ARGS, KeyedQueue, git, runGit } from './git.ts';
import type { Workspaces } from './workspace.ts';

/** Prefix of Harness's branches: the managed folder's name without its dot (git refuses `.harness/…`). */
export const BRANCH_PREFIX = MANAGED_DIR.replace(/^\.+/, '') || 'harness';

/** The largest diff sent to the page; bigger ones are cut (the file list stays complete). */
const MAX_DIFF_CHARS = 400_000;

/** Where a project's files live in git. */
interface RepoInfo {
  /** The repository's top folder (the project folder, or a folder above it). */
  top: string;
  /** The project folder relative to `top` ('' when they are the same). */
  rel: string;
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
  /** For a merge node: what each merged branch changed, and files left with conflict markers. */
  merged: { title: string; files: string[] }[];
  conflicts: string[];
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
      const result = (created: boolean, merged: NodeWorktree['merged'] = [], conflicts: string[] = []): NodeWorktree => ({
        branch, worktree, editDir: path.join(worktree, repo.rel), created, merged, conflicts,
      });

      if (existsSync(path.join(worktree, '.git'))) return result(false);
      mkdirSync(path.dirname(worktree), { recursive: true });
      if (await this.branchExists(repo.top, branch)) {
        await git(repo.top, ['worktree', 'prune']);
        await git(repo.top, ['worktree', 'add', worktree, branch]);
        return result(false);
      }

      // Named like the merged results in the prompt (by the title they were created with).
      const starts = node.parentIds.map((id) => ({ title: graph.node(id).promptTitle, ref: this.startOf(graph, id) }));
      const first = starts.find((s) => s.ref)?.ref ?? (await this.userCommit(repo.top));
      await git(repo.top, ['worktree', 'prune']); // forget worktrees whose folders were deleted by hand
      await git(repo.top, ['worktree', 'add', '-b', branch, worktree, first]);

      // A merge node: merge the other branches in, one at a time.
      const merged: NodeWorktree['merged'] = [];
      const conflicts = new Set<string>();
      if (node.parentIds.length > 1) {
        const refs = [...new Set(starts.flatMap((s) => (s.ref ? [s.ref] : [])))];
        const base = refs.length > 1 ? (await git(repo.top, ['merge-base', '--octopus', ...refs])).trim() : first;
        for (const { title, ref } of starts) {
          if (ref) merged.push({ title, files: await this.changedFiles(repo.top, base, ref) });
          if (!ref || ref === first) continue;
          const out = await runGit(worktree, [...HARNESS_COMMIT_ARGS, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', `Merge "${title}"`, ref]);
          if (out.code === 0) continue;
          const unmerged = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
          if (unmerged.length === 0) throw new Error(`Could not merge the files of "${title}": ${out.stderr.trim()}`);
          unmerged.forEach((f) => conflicts.add(f));
          await git(worktree, ['add', '-A']);
          await git(worktree, [...HARNESS_COMMIT_ARGS, 'commit', '--no-edit', '--no-verify', '-m', `Merge "${title}" (conflicts left in ${unmerged.join(', ')})`]);
        }
      }
      return result(true, merged, [...conflicts]);
    });
  }

  /** Commit whatever the model changed in the node's worktree. Returns whether anything was committed. */
  commit(project: Project, nodeId: string, message: string): Promise<boolean> {
    const folder = this.workspaces.folderOf(project);
    return this.queue.run(folder, () => this.commitCopy(this.worktreeOf(project, nodeId), message));
  }

  /**
   * A node was forked and goes on: commit its copy and start each branch's git branch where it is
   * now, so the branches get the files as they were at the fork even if the parent edits on
   * before they first run. (A branch's worktree is still made at its first run, by `ensure`.)
   */
  fork(project: Project, parentId: string, childIds: string[], message: string): Promise<void> {
    const folder = this.workspaces.folderOf(project);
    return this.queue.run(folder, async () => {
      await this.commitCopy(this.worktreeOf(project, parentId), message);
      const repo = await this.findRepo(folder);
      const from = Worktrees.branchOf(parentId);
      if (!repo || !(await this.branchExists(repo.top, from))) return;
      for (const id of childIds) {
        const branch = Worktrees.branchOf(id);
        if (!(await this.branchExists(repo.top, branch))) await git(repo.top, ['branch', branch, from]);
      }
    });
  }

  private async commitCopy(worktree: string, message: string): Promise<boolean> {
    if (!existsSync(path.join(worktree, '.git'))) return false;
    await git(worktree, ['add', '-A']);
    if ((await runGit(worktree, ['diff', '--cached', '--quiet'])).code === 0) return false;
    await git(worktree, [...HARNESS_COMMIT_ARGS, 'commit', '--no-verify', '-m', message]);
    return true;
  }

  /** Commit and remove a node's worktree (it was finished); its branch keeps the files. */
  retire(project: Project, nodeId: string, message: string): Promise<void> {
    const folder = this.workspaces.folderOf(project);
    const worktree = this.worktreeOf(project, nodeId);
    return this.commit(project, nodeId, message).then(() =>
      this.queue.run(folder, async () => {
        if (!existsSync(worktree)) return;
        const repo = await this.findRepo(folder);
        if (repo) await git(repo.top, ['worktree', 'remove', '--force', worktree]);
      }));
  }

  /**
   * What applying the node's branch would bring into the user's current branch: changed files, the
   * diff, and conflicts. `null` when the node has no branch.
   */
  changes(project: Project, nodeId: string): Promise<NodeChanges | null> {
    const folder = this.workspaces.folderOf(project);
    const branch = Worktrees.branchOf(nodeId);
    return this.queue.run(folder, async () => {
      const repo = await this.findRepo(folder);
      if (!repo || !(await this.branchExists(repo.top, branch))) return null;
      const target = (await runGit(repo.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
      const base = await this.userCommit(repo.top);
      const range = `${base}...${branch}`;
      const files = parseNumstat(
        await git(repo.top, ['diff', '--numstat', '-z', '-M', range]),
        await git(repo.top, ['diff', '--name-status', '-z', '-M', range]),
      );
      const full = await git(repo.top, ['diff', '-M', range]);
      const applied = (await runGit(repo.top, ['merge-base', '--is-ancestor', branch, base])).code === 0;
      const conflicts = applied ? [] : await this.conflictsWith(repo.top, base, branch);
      // Changed files that still hold merge conflict markers (a merge the model hasn't resolved yet).
      const changed = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
      const markers = changed.length === 0 ? '' : (await runGit(repo.top, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', branch, '--', ...changed])).stdout;
      return {
        branch,
        target,
        files,
        unresolved: markers.split('\n').filter(Boolean).map((l) => l.slice(branch.length + 1)),
        diff: full.slice(0, MAX_DIFF_CHARS),
        truncated: full.length > MAX_DIFF_CHARS,
        conflicts,
        applied,
      };
    });
  }

  /** How many files the node's branch changes compared with the user's branch (null: no branch). */
  async countChanges(project: Project, nodeId: string): Promise<number | null> {
    const changes = await this.changes(project, nodeId);
    return changes ? changes.files.length : null;
  }

  /**
   * Merge the node's branch into the user's current branch, in the project folder. Refuses on a
   * detached HEAD; on conflicts it aborts, so the user's folder is left as it was.
   */
  apply(project: Project, nodeId: string, title: string): Promise<{ ok: true } | { ok: false; error: string; conflicts: string[] }> {
    const folder = this.workspaces.folderOf(project);
    const branch = Worktrees.branchOf(nodeId);
    return this.queue.run(folder, async () => {
      const repo = await this.requireRepo(folder);
      if (!(await this.branchExists(repo.top, branch))) return { ok: false, error: 'This node has no file changes.', conflicts: [] };
      const target = (await runGit(repo.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
      if (!target) return { ok: false, error: 'The project folder is not on a branch (detached HEAD). Check out a branch first.', conflicts: [] };
      // The user's own identity if git has one, else Harness's.
      const hasIdentity = (await runGit(repo.top, ['config', 'user.email'])).code === 0;
      const identity = hasIdentity ? [] : HARNESS_COMMIT_ARGS;
      const out = await runGit(repo.top, [...identity, 'merge', '--no-ff', '--no-edit', '-m', `Apply Harness branch "${title}" (${branch})`, branch]);
      if (out.code === 0) return { ok: true };
      const conflicts = (await git(repo.top, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      if (conflicts.length > 0) {
        await runGit(repo.top, ['merge', '--abort']);
        return { ok: false, error: `Applying would conflict with your changes in ${conflicts.join(', ')}. Nothing was changed.`, conflicts };
      }
      const detail = (out.stderr || out.stdout).trim().split('\n').filter(Boolean).slice(0, 6).join('\n');
      return { ok: false, error: `Git could not apply the changes:\n${detail}`, conflicts: [] };
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
        current = (await git(repo.top, [...HARNESS_COMMIT_ARGS, 'commit-tree', tree, '-p', current, '-p', ref, '-m', 'merge preview'])).trim();
      }
      return { branches, conflicts: [...conflicts] };
    });
  }

  // ---- helpers ----

  /** Where to start a node's branch from: the nearest node up the first-parent line that has a branch. */
  private startOf(graph: GraphReader, nodeId: string): string | null {
    for (let id: string | undefined = nodeId; id; id = graph.node(id).parentIds[0]) {
      if (graph.node(id).gitBranch) return graph.node(id).gitBranch;
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

  /** The user's current commit, or for a repository without commits, an empty commit to start from. */
  private async userCommit(top: string): Promise<string> {
    const head = await runGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code === 0) return head.stdout.trim();
    const emptyTree = (await git(top, ['mktree'], '')).trim();
    return (await git(top, [...HARNESS_COMMIT_ARGS, 'commit-tree', emptyTree, '-m', 'Empty start'])).trim();
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
    await git(folder, [...HARNESS_COMMIT_ARGS, 'commit', '--allow-empty', '--no-verify', '-m', 'Start of the Harness project']);
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
