import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Python programs that run in containers, in `container/` next to this file:
 *   mcp-stub.py      the harness tools' stand-in inside every sandbox (they don't work there)
 *   egress-proxy.py  the sandbox network's only way out (see egress.ts)
 * They ship as files: the npx package and the desktop app copy the folder next to their bundle
 * (`dist/container/`), where this same relative path finds them.
 */
export type ContainerScript = 'mcp-stub.py' | 'egress-proxy.py';

/** Where a container script is on disk. */
export function containerScriptPath(name: ContainerScript): string {
  return fileURLToPath(new URL(`./container/${name}`, import.meta.url));
}

/** A container script's text (read with readFileSync: inside the desktop app's archive, files can only be read). */
export function containerScript(name: ContainerScript): string {
  return readFileSync(containerScriptPath(name), 'utf8');
}

/** Where the scripts and the tool definitions are inside a container. */
export const STUB_DIR = '/opt/harness';

/**
 * Put the container scripts and the harness tools' definitions in `dir`, which is mounted
 * read-only into every sandbox and the egress proxy.
 */
export function writeContainerFiles(dir: string, tools: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['mcp-stub.py', 'egress-proxy.py'] as const) writeFileSync(path.join(dir, name), containerScript(name));
  writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools));
}

/**
 * The `--mcp-config` for a sandboxed CLI: the harness server's name, with the stub behind it. It
 * lists the same tool definitions, so the prompt (and its cache) is the same as outside.
 */
export function stubMcpConfig(timeoutMs: number): string {
  return JSON.stringify({
    mcpServers: {
      harness: { type: 'stdio', command: 'python3', args: [`${STUB_DIR}/mcp-stub.py`, `${STUB_DIR}/tools.json`], timeout: timeoutMs, alwaysLoad: true },
    },
  });
}
