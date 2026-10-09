import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** How to start the editor: a program, and arguments that come before the folder and file. */
export interface EditorCommand {
  command: string;
  args: string[];
  /** `open -b …` (macOS) reports a missing app only through its exit code, so wait for it. */
  waitForExit?: boolean;
}

/** Open a folder in the editor, and optionally one of its files (absolute paths). */
export type OpenInEditor = (folder: string, file?: string) => Promise<void>;

export class EditorNotFoundError extends Error {
  constructor() {
    super('VS Code was not found on this computer. Install it, or set HARNESS_EDITOR_PATH to its program (Code.exe on Windows, code on macOS and Linux) and restart Harness.');
  }
}

/**
 * Open a folder (and a file in it) in VS Code, found the way `findVSCode` describes. The editor is
 * started on its own: closing Harness doesn't close it.
 */
export const openInEditor: OpenInEditor = async (folder, file) => {
  const editor = await findVSCode();
  if (!editor) throw new EditorNotFoundError();
  await launch(editor, [...editor.args, folder, ...(file ? [file] : [])]);
};

/**
 * Where VS Code is, per OS (null: not found):
 *   any:     HARNESS_EDITOR_PATH (VS Code's program, or another editor that takes the same arguments)
 *   Windows: the program the installer registered for vscode:// links (the exact path, per-user or
 *            for all users), then the usual install folders, then `code` on PATH. Always Code.exe
 *            itself: Node won't start the `code.cmd` script without a shell.
 *   macOS:   the command-line script inside the app (works without "Install 'code' command in
 *            PATH"), `code` on PATH, else `open -b com.microsoft.VSCode` (finds the app anywhere).
 *   Linux:   `code` on PATH, the snap, then the flatpak.
 */
export async function findVSCode(env: NodeJS.ProcessEnv = process.env): Promise<EditorCommand | null> {
  const custom = env.HARNESS_EDITOR_PATH?.trim();
  if (custom) return existsSync(custom) ? { command: custom, args: [] } : null;
  if (process.platform === 'win32') return findWindows(env);
  if (process.platform === 'darwin') return findMac(env);
  return findLinux(env);
}

async function findWindows(env: NodeJS.ProcessEnv): Promise<EditorCommand | null> {
  for (const root of ['HKCU', 'HKLM']) {
    const exe = await registeredExe(`${root}\\Software\\Classes\\vscode\\shell\\open\\command`);
    if (exe && path.basename(exe).toLowerCase() === 'code.exe' && existsSync(exe)) return { command: exe, args: [] };
  }
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    // `code.cmd` on PATH sits in <install>\bin\.
    ...onPath('code.cmd', env).map((cmd) => path.join(path.dirname(cmd), '..', 'Code.exe')),
  ];
  const exe = candidates.find((c): c is string => !!c && existsSync(c));
  return exe ? { command: path.resolve(exe), args: [] } : null;
}

/** The program in a registry `command` value, e.g. `"C:\…\Code.exe" --open-url -- "%1"`. */
function registeredExe(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const value = /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(stdout)?.[1].trim() ?? '';
      resolve(/^"([^"]+)"/.exec(value)?.[1] ?? (value.split(' ')[0] || null));
    });
  });
}

function findMac(env: NodeJS.ProcessEnv): EditorCommand | null {
  const script = 'Visual Studio Code.app/Contents/Resources/app/bin/code';
  const found = [path.join('/Applications', script), path.join(homedir(), 'Applications', script), ...onPath('code', env)].find(existsSync);
  if (found) return { command: found, args: [] };
  return { command: 'open', args: ['-b', 'com.microsoft.VSCode'], waitForExit: true };
}

function findLinux(env: NodeJS.ProcessEnv): EditorCommand | null {
  const found = [...onPath('code', env), '/snap/bin/code', '/usr/share/code/bin/code'].find(existsSync);
  if (found) return { command: found, args: [] };
  const flatpak = ['/var/lib/flatpak/app/com.visualstudio.code', path.join(homedir(), '.local/share/flatpak/app/com.visualstudio.code')];
  if (flatpak.some(existsSync)) return { command: 'flatpak', args: ['run', 'com.visualstudio.code'] };
  return null;
}

/** Every `name` in the PATH folders. */
function onPath(name: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, name)).filter(existsSync);
}

function launch(editor: EditorCommand, args: string[]): Promise<void> {
  // Electron reads these: started from inside an Electron app (the desktop app), VS Code would run as plain Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return new Promise((resolve, reject) => {
    const child = spawn(editor.command, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new EditorNotFoundError() : err));
    if (editor.waitForExit) {
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new EditorNotFoundError())));
    } else {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }
  });
}
