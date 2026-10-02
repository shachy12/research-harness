import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Attachment, Project } from '@harness/shared';

/**
 * Each project has a working folder. The model (Claude Code) runs there and can read files inside
 * it, and nowhere else. Our managed data lives in `.harness/` inside that folder:
 *
 *   <folder>/.harness/uploads/   files the user attached to messages
 *
 * Until the user can choose a folder, it defaults to `<data>/projects/<project id>/`.
 */
export class Workspaces {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  folderOf(project: Project): string {
    return project.folder ?? path.join(this.dataDir, 'projects', project.id);
  }

  uploadsOf(project: Project): string {
    return path.join(this.folderOf(project), '.harness', 'uploads');
  }

  /** Create the folder structure if needed; returns the working folder. */
  prepare(project: Project): string {
    const harness = path.join(this.folderOf(project), '.harness');
    mkdirSync(path.join(harness, 'uploads'), { recursive: true });
    // If the folder is a git repository, keep our managed data out of it.
    const gitignore = path.join(harness, '.gitignore');
    if (!existsSync(gitignore)) writeFileSync(gitignore, '# Managed by Harness\n*\n');
    return this.folderOf(project);
  }

  /** Copy an uploaded file into the project's uploads folder under a safe, unused name. */
  saveUpload(project: Project, originalName: string, bytes: Uint8Array): Attachment {
    this.prepare(project);
    const uploads = this.uploadsOf(project);
    const name = uniqueName(uploads, safeFileName(originalName));
    const target = path.join(uploads, name);
    writeFileSync(target, bytes, { flag: 'wx' });
    return { name, path: target, size: bytes.byteLength, kind: 'file' };
  }

  /**
   * Copy an uploaded folder into the uploads folder, keeping its structure. `files` paths are
   * relative to the folder (`figures/plot.png`); every part is made safe, so nothing can be written
   * outside it. The folder gets an unused name (`paper`, `paper-2`, …).
   */
  saveFolder(project: Project, folderName: string, files: { path: string; bytes: Uint8Array }[]): Attachment {
    this.prepare(project);
    const name = uniqueName(this.uploadsOf(project), safeFileName(folderName));
    const root = path.join(this.uploadsOf(project), name);
    mkdirSync(root);

    let size = 0;
    for (const file of files) {
      const parts = file.path.split(/[\\/]/).filter(Boolean).map(safeFileName);
      if (parts.length === 0) continue;
      const dir = path.join(root, ...parts.slice(0, -1));
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, uniqueName(dir, parts.at(-1)!));
      writeFileSync(target, file.bytes, { flag: 'wx' });
      size += file.bytes.byteLength;
    }
    return { name, path: root, size, kind: 'folder', fileCount: files.length };
  }

  /**
   * Check attachments sent with a message: each must be an existing file or folder directly in this
   * project's uploads folder (a client can't point the model at other files). Returns them with the
   * real name, size and kind.
   */
  validate(project: Project, attachments: Attachment[]): Attachment[] | { error: string } {
    const uploads = path.resolve(this.uploadsOf(project));
    const checked: Attachment[] = [];
    for (const a of attachments) {
      const resolved = path.resolve(a.path);
      if (path.dirname(resolved) !== uploads || !existsSync(resolved)) {
        return { error: `Attachment "${a.name}" is not an upload of this project` };
      }
      const stats = statSync(resolved);
      if (stats.isDirectory()) {
        const { size, fileCount } = folderStats(resolved);
        checked.push({ name: path.basename(resolved), path: resolved, size, kind: 'folder', fileCount });
      } else {
        checked.push({ name: path.basename(resolved), path: resolved, size: stats.size, kind: 'file' });
      }
    }
    return checked;
  }
}

function folderStats(dir: string): { size: number; fileCount: number } {
  let size = 0;
  let fileCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      size += statSync(path.join(entry.parentPath, entry.name)).size;
      fileCount++;
    }
  }
  return { size, fileCount };
}

/** A file name that is safe on Windows, macOS and Linux: no path parts, no reserved characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(-120);
  return cleaned || 'file';
}

/** `paper.pdf`, or `paper-2.pdf`, `paper-3.pdf`, … if that name is taken. */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
}
