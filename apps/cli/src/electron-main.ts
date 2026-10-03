import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { startServer, type RunningServer } from '../../server/src/server.ts';
import { DEFAULT_PORT, dataDir, loadEnvFiles } from './config.ts';

/**
 * The window for `npx research-harness --app`: Electron's main process runs the Harness server
 * in-process and opens a window onto it, like apps/desktop does, but from the npm package: the
 * launcher (cli.ts) fetches Electron into the data folder and starts it on this file.
 * Needs HARNESS_WEB_DIR (the built web UI); the launcher sets it.
 */

const data = dataDir();
const webDir = process.env.HARNESS_WEB_DIR ?? '';
let server: RunningServer | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

// Window state (localStorage etc.) lives in the data folder, not in a folder named after Electron.
app.setName('research-harness');
app.setPath('userData', path.join(data, 'electron-profile'));

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
    loadEnvFiles(data);
    if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error(`The web UI is missing (${webDir}). Reinstall the package.`);
    server = await listen();
    openWindow(server.url);
  } catch (err) {
    console.error(err);
    dialog.showErrorBox('Harness could not start', err instanceof Error ? err.message : String(err));
    app.exit(1);
  }
}

async function listen(): Promise<RunningServer> {
  const options = { dataDir: data, dbFile: process.env.HARNESS_DB, hostname: '127.0.0.1', webDir, pickFolder };
  const port = Number(process.env.HARNESS_SERVER_PORT ?? DEFAULT_PORT);
  try {
    return await startServer({ ...options, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
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
