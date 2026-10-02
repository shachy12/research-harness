import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@harness/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspaces, safeFileName } from './workspace.ts';

let dataDir: string;
let workspaces: Workspaces;
const project: Project = { id: 'p1', name: 'Test', folder: null, createdAt: '' };
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'harness-ws-'));
  workspaces = new Workspaces(dataDir);
});

describe('Workspaces', () => {
  it('defaults to a folder per project under the data folder, or uses the chosen one', () => {
    expect(workspaces.folderOf(project)).toBe(path.join(dataDir, 'projects', 'p1'));
    expect(workspaces.folderOf({ ...project, folder: 'D:\\Research' })).toBe('D:\\Research');
  });

  it('creates .harness/uploads and a .gitignore that keeps it out of git', () => {
    const folder = workspaces.prepare(project);
    expect(existsSync(path.join(folder, '.harness', 'uploads'))).toBe(true);
    expect(readFileSync(path.join(folder, '.harness', '.gitignore'), 'utf8')).toContain('*');
  });

  it('saves uploads under safe, unique names', () => {
    const a = workspaces.saveUpload(project, 'paper.pdf', bytes('one'));
    const b = workspaces.saveUpload(project, 'paper.pdf', bytes('two'));
    const c = workspaces.saveUpload(project, '..\\..\\evil:name?.tex', bytes('three'));

    expect(a).toEqual({ name: 'paper.pdf', path: path.join(workspaces.uploadsOf(project), 'paper.pdf'), size: 3, kind: 'file' });
    expect(b.name).toBe('paper-2.pdf');
    expect(readFileSync(b.path, 'utf8')).toBe('two');
    expect(c.name).toBe('evil_name_.tex');
    expect(path.dirname(c.path)).toBe(workspaces.uploadsOf(project));
  });

  it('accepts only existing files in the uploads folder as attachments', () => {
    const saved = workspaces.saveUpload(project, 'notes.tex', bytes('\\section{Intro}'));
    expect(workspaces.validate(project, [saved])).toEqual([saved]);

    const outside = path.join(dataDir, 'secret.txt');
    writeFileSync(outside, 'secret');
    expect(workspaces.validate(project, [{ name: 'secret.txt', path: outside, size: 6 }])).toHaveProperty('error');

    const sneaky = path.join(workspaces.uploadsOf(project), '..', '..', '..', 'secret.txt');
    expect(workspaces.validate(project, [{ name: 'x', path: sneaky, size: 6 }])).toHaveProperty('error');

    const missing = path.join(workspaces.uploadsOf(project), 'missing.pdf');
    expect(workspaces.validate(project, [{ name: 'missing.pdf', path: missing, size: 1 }])).toHaveProperty('error');
  });
});

describe('folders', () => {
  it('saves a folder with its structure under an unused name', () => {
    const files = [
      { path: 'main.tex', bytes: bytes('\\input{sections/intro}') },
      { path: 'sections/intro.tex', bytes: bytes('Intro') },
      { path: 'figures\\plot.png', bytes: bytes('png') },
    ];
    const first = workspaces.saveFolder(project, 'paper', files);
    expect(first).toMatchObject({ name: 'paper', kind: 'folder', fileCount: 3, size: 30 });
    expect(readFileSync(path.join(first.path, 'sections', 'intro.tex'), 'utf8')).toBe('Intro');
    expect(existsSync(path.join(first.path, 'figures', 'plot.png'))).toBe(true);

    const second = workspaces.saveFolder(project, 'paper', files);
    expect(second.name).toBe('paper-2');
  });

  it('keeps every file inside the folder, whatever the paths say', () => {
    const saved = workspaces.saveFolder(project, 'evil', [
      { path: '../../outside.txt', bytes: bytes('x') },
      { path: 'C:\\Windows\\win.ini', bytes: bytes('y') },
    ]);
    expect(existsSync(path.join(workspaces.uploadsOf(project), '..', 'outside.txt'))).toBe(false);
    expect(existsSync(path.join(saved.path, 'file', 'file', 'outside.txt'))).toBe(true); // '..' parts made harmless
    expect(existsSync(path.join(saved.path, 'C_', 'Windows', 'win.ini'))).toBe(true);
  });

  it('accepts an uploaded folder as an attachment, with its real size and file count', () => {
    const saved = workspaces.saveFolder(project, 'notes', [
      { path: 'a.md', bytes: bytes('aaaa') },
      { path: 'sub/b.md', bytes: bytes('bb') },
    ]);
    expect(workspaces.validate(project, [{ name: 'x', path: saved.path, size: 0 }])).toEqual([
      { name: 'notes', path: saved.path, size: 6, kind: 'folder', fileCount: 2 },
    ]);
    // A folder deeper inside an upload is not an attachment by itself.
    expect(workspaces.validate(project, [{ name: 'sub', path: path.join(saved.path, 'sub'), size: 0 }])).toHaveProperty('error');
  });
});

describe('safeFileName', () => {
  it('strips paths and reserved characters', () => {
    expect(safeFileName('C:\\Users\\me\\paper.pdf')).toBe('paper.pdf');
    expect(safeFileName('a/b/c.tex')).toBe('c.tex');
    expect(safeFileName('what?.txt')).toBe('what_.txt');
    expect(safeFileName('...')).toBe('file');
  });
});
