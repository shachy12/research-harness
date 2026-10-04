import os from 'node:os';
import path from 'node:path';

// Own port, remembered between launches: the web page's origin (127.0.0.1:PORT) owns its
// localStorage (last project, sidebar state), so a new port each launch would forget it all.
export const DEFAULT_PORT = 47831;

/** HARNESS_DATA_DIR, else a per-user folder. */
export function dataDir(): string {
  if (process.env.HARNESS_DATA_DIR) return path.resolve(process.env.HARNESS_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'research-harness');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'research-harness');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'research-harness');
}

