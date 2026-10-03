import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { startServer, type RunningServer } from '../../server/src/server.ts';

/**
 * The desktop app: Electron's main process runs the Harness server in-process (the same code as
 * `npm run dev -w @harness/server`) and opens a window onto it. The window shows the built web UI
 * served by that server, or, with HARNESS_DEV_URL, the Vite dev server (hot reload).
 *
 * Folder dialogs are Electron's own (`dialog.showOpenDialog`), passed to the server in place of its
 * per-OS helper, so choosing a folder behaves natively on Windows, macOS and Linux.
 */

// Own port, remembered between launches: the web page's origin (localhost:PORT) owns its
// localStorage (last project, sidebar state), so a new port each launch would forget it all.
const DEFAULT_PORT = 47831;
const devUrl = process.env.HARNESS_DEV_URL; // e.g. http://localhost:5173
// In development this file is apps/desktop/dist/main.mjs; packaged, the repository doesn't exist.
const repoRoot = path.resolve(import.meta.dirname, '../../..');

let server: RunningServer | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  // A second copy would open the same database; focus the first one instead.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    const stopping = server.close().catch((err) => console.error('stopping the server failed', err));
    // Never hang on quit (e.g. a model process that won't stop).
    void Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 5000))]).then(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (server && BrowserWindow.getAllWindows().length === 0) openWindow(server.url);
  });
  void app.whenReady().then(main);
}

async function main() {
  try {
    loadEnvFiles();
    server = await listen();
    openWindow(devUrl ?? server.url);
  } catch (err) {
    console.error(err);
    dialog.showErrorBox('Harness could not start', err instanceof Error ? err.message : String(err));
    app.exit(1);
  }
}

/** Settings files: the repository's `.env` when run from source, and one in the app's data folder. */
function loadEnvFiles() {
  const files = [process.env.HARNESS_ENV_FILE, app.isPackaged ? undefined : path.join(repoRoot, '.env'), path.join(app.getPath('userData'), '.env')];
  for (const file of files) {
    // Variables already set (by the launcher or an earlier file) win.
    if (file && fs.existsSync(file)) process.loadEnvFile(file);
  }
}

function dataDir(): string {
  if (process.env.HARNESS_DATA_DIR) return path.resolve(process.env.HARNESS_DATA_DIR);
  // From source it is the same folder `npm run dev` uses, so your projects are there. Don't run both at once.
  return app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(repoRoot, 'data');
}

async function listen(): Promise<RunningServer> {
  const webDir = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(repoRoot, 'apps/web/dist');
  const options = {
    dataDir: dataDir(),
    dbFile: process.env.HARNESS_DB,
    hostname: '127.0.0.1', // this machine only
    webDir: devUrl ? undefined : webDir,
    pickFolder,
  };
  if (!devUrl && !fs.existsSync(path.join(webDir, 'index.html'))) {
    throw new Error(`The web UI is not built (missing ${webDir}). Run "npm run build -w @harness/web".`);
  }
  // In development the Vite page proxies /api to a fixed port.
  const port = Number(process.env.HARNESS_SERVER_PORT ?? (devUrl ? 8787 : DEFAULT_PORT));
  try {
    return await startServer({ ...options, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || devUrl) throw err;
    return startServer({ ...options, port: 0 }); // taken by another program: any free port
  }
}

/** The server's folder-dialog hook: Electron's native dialog, as a child of the focused window. */
async function pickFolder({ title, startIn }: { title: string; startIn?: string }): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options = { title, defaultPath: startIn || undefined, properties: ['openDirectory' as const, 'createDirectory' as const] };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function openWindow(url: string) {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Harness',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.once('ready-to-show', () => win.show());

  // The window shows only the app; links to other sites open in the user's browser.
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return;
    event.preventDefault();
    openExternal(target);
  });
  void win.loadURL(url);
}

function openExternal(target: string) {
  // Never hand file: or custom schemes to the OS.
  if (/^(https?|mailto):/i.test(target)) void shell.openExternal(target);
}
