import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeProvider, answerToolArgs, dockerRunArgs, mapEvent, newTurnState, sandboxToolArgs, toolArgs } from '../llm/claude-code.ts';
import type { ReplyContext, ReplyEvent, SandboxRun } from '../llm/provider.ts';
import { sandboxSettingsSchema } from '@harness/shared';
import { hostCertificates } from './certs.ts';
import { EGRESS_HOST, EGRESS_PORT, egressEnv } from './egress.ts';
import { assertNoDockerSocket, dockerSocketPaths, isDockerVariable, upstreamProxy } from './isolation.ts';
import { SandboxImages, buildError, certificateFiles, classifyDockerError, customImageTag, defaultImageTag, dockerEnv } from './docker.ts';
import { containerPath, isInside, mountSpec, sessionFolderName } from './paths.ts';
import { copySessionBack, copySessionIn, sessionDir } from './sessions.ts';
import { containerScriptPath, stubMcpConfig, writeContainerFiles } from './stub.ts';

describe('sandbox paths', () => {
  it('maps folders of this machine to the container: drive letters on Windows, the same path elsewhere', () => {
    expect(containerPath('C:\\Users\\Ann\\My research', 'win32')).toBe('/c/Users/Ann/My research');
    expect(containerPath('D:\\', 'win32')).toBe('/d');
    expect(containerPath('/home/ann/research/', 'linux')).toBe('/home/ann/research/');
    expect(() => containerPath('\\\\server\\share\\x', 'win32')).toThrow(/drive letter/);
  });

  it('tells whether a folder is inside another', () => {
    expect(isInside('C:\\a\\b\\.git', 'C:\\a', 'win32')).toBe(true);
    expect(isInside('C:\\ab', 'C:\\a', 'win32')).toBe(false);
    expect(isInside('/a/b', '/a', 'linux')).toBe(true);
  });

  it('names session folders like Claude Code does', () => {
    expect(sessionFolderName('/c/Users/Ann/proj')).toBe('-c-Users-Ann-proj');
    expect(sessionFolderName('C:\\Users\\Ann\\proj')).toBe('C--Users-Ann-proj');
  });

  it('quotes --mount fields that contain commas or quotes', () => {
    expect(mountSpec({ source: 'C:\\a', target: '/c/a', readonly: true })).toBe('type=bind,source=C:\\a,target=/c/a,readonly');
    expect(mountSpec({ source: '/x,y', target: '/x,y', readonly: false })).toBe('type=bind,"source=/x,y","target=/x,y"');
  });
});

describe('sandbox sessions', () => {
  let root: string;
  const id = '11111111-2222-4333-8444-555555555555';
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'harness-sessions-'));
  });

  it('copies only the one session in, and a valid session back', () => {
    const host = { claudeDir: path.join(root, 'host'), workDir: 'C:\\proj' };
    const inside = { claudeDir: path.join(root, 'inside'), workDir: '/c/proj' };
    mkdirSync(sessionDir(host.claudeDir, host.workDir), { recursive: true });
    writeFileSync(path.join(sessionDir(host.claudeDir, host.workDir), `${id}.jsonl`), '{"a":1}\n');
    writeFileSync(path.join(sessionDir(host.claudeDir, host.workDir), 'other.jsonl'), '{"secret":1}\n');

    expect(copySessionIn(id, host, inside)).toBe(true);
    const copied = path.join(inside.claudeDir, 'projects', '-c-proj');
    expect(readFileSync(path.join(copied, `${id}.jsonl`), 'utf8')).toBe('{"a":1}\n');
    expect(existsSync(path.join(copied, 'other.jsonl'))).toBe(false);

    writeFileSync(path.join(copied, `${id}.jsonl`), '{"a":1}\n{"b":2}\n');
    expect(copySessionBack(id, inside, host)).toBe(true);
    expect(readFileSync(path.join(sessionDir(host.claudeDir, host.workDir), `${id}.jsonl`), 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it("refuses what isn't a session: a broken file, an id that isn't a UUID", () => {
    const host = { claudeDir: path.join(root, 'host'), workDir: '/proj' };
    const inside = { claudeDir: path.join(root, 'inside'), workDir: '/proj' };
    const dir = path.join(inside.claudeDir, 'projects', '-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.jsonl`), '{"a":1}\nnot json\n');
    expect(copySessionBack(id, inside, host)).toBe(false);
    writeFileSync(path.join(dir, `${id}.jsonl`), '[1,2]\n');
    expect(copySessionBack(id, inside, host)).toBe(false);
    expect(copySessionBack('../../evil', inside, host)).toBe(false);
    expect(copySessionIn('../../evil', host, inside)).toBe(false);
  });
});

describe('docker', () => {
  it('explains why Docker does not answer', () => {
    expect(classifyDockerError('permission denied while trying to connect to the docker API at unix:///var/run/docker.sock').state).toBe('no-permission');
    expect(classifyDockerError('failed to connect to the docker API at npipe:////./pipe/docker_engine; check if the path is correct and if the daemon is running').state).toBe('not-running');
    expect(classifyDockerError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?').state).toBe('not-running');
    expect(buildError('Could not connect to archive.ubuntu.com:80 (185.125.190.83), connection timed out', 100)).toMatch(/can't reach the internet/);
  });

  it('tags images by Claude Code version and Dockerfile', () => {
    expect(defaultImageTag('2.1.287')).toMatch(/^harness-sandbox:2\.1\.287-[0-9a-f]{8}$/);
    expect(customImageTag('FROM harness-sandbox', 'a')).not.toBe(customImageTag('FROM harness-sandbox', 'b'));
  });

  it("puts docker's own folder first on PATH (Docker Desktop's helpers live there)", () => {
    const env = dockerEnv(path.resolve('/opt/docker/bin/docker'), { PATH: '/usr/bin' });
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.resolve('/opt/docker/bin'));
    expect(dockerEnv('docker', { PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
  });
});

const run = (over: Partial<SandboxRun> = {}): SandboxRun => ({
  docker: { command: 'docker' },
  image: 'harness-sandbox:test',
  mounts: [
    { source: '/home/ann/proj', target: '/home/ann/proj', readonly: true },
    { source: '/home/ann/proj/.harness/work/abc', target: '/home/ann/proj/.harness/work/abc', readonly: false },
  ],
  secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret' },
  env: { HOME: '/home/harness' },
  network: 'harness-sandbox-lbl',
  workDir: '/home/ann/proj',
  editDir: '/home/ann/proj/.harness/work/abc',
  user: '1000:1000',
  runsDir: '/tmp/runs',
  stubDir: '/data/sandbox/stub',
  label: 'lbl',
  ...over,
});

describe('docker run arguments', () => {
  it('passes secrets by name only, mounts the home folder first, and runs claude with the CLI arguments', () => {
    const args = dockerRunArgs(run(), { name: 'harness-x', home: '/tmp/runs/run-1', cliArgs: ['-p', '--verbose'] });
    expect(args.join(' ')).not.toContain('sk-secret');
    expect(args).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN', '-e', 'HOME=/home/harness', '--user', '1000:1000', '-w', '/home/ann/proj']));
    const mounts = args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
    expect(mounts[0]).toBe('type=bind,source=/tmp/runs/run-1,target=/home/harness');
    expect(mounts[1]).toBe('type=bind,source=/data/sandbox/stub,target=/opt/harness,readonly');
    expect(mounts).toContain('type=bind,source=/home/ann/proj,target=/home/ann/proj,readonly');
    expect(args.slice(-4)).toEqual(['harness-sandbox:test', 'claude', '-p', '--verbose']);
    expect(args).toEqual(expect.arrayContaining(['--rm', '--label', 'harness.sandbox=lbl', '--network', 'harness-sandbox-lbl', '--security-opt', 'no-new-privileges', '--cap-drop', 'NET_RAW']));
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toMatch(/docker\.sock|--network host/);
  });

  it('lists the same tools as outside (the prompt and its cache stay the same), with the stub for the harness tools', () => {
    const tools = (a: string[]) => a[a.indexOf('--tools') + 1];
    expect(tools(sandboxToolArgs(true, true))).toBe(tools(toolArgs('/p', { dir: '/p/.harness/work/a' }, 'http://x')));
    expect(tools(sandboxToolArgs(true, false))).toBe(tools(answerToolArgs('http://x')));
    const allowed = (a: string[]) => a[a.indexOf('--allowedTools') + 1];
    expect(allowed(sandboxToolArgs(true, true))).toContain('Bash');
    expect(allowed(sandboxToolArgs(true, false))).not.toContain('Bash');
    expect(sandboxToolArgs(true, true)).toContain(stubMcpConfig(30 * 60_000));
  });

  it('ignores session ids that are not UUIDs (they end up in command lines)', () => {
    expect(mapEvent({ type: 'system', subtype: 'init', session_id: '--dangerously-skip-permissions' }, newTurnState())).toEqual([]);
  });
});

describe('the MCP stub', () => {
  const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

  it.skipIf(!python)('lists the tools it was given and refuses every call', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-stub-'));
    writeFileSync(path.join(dir, 'tools.json'), JSON.stringify([{ name: 'ask_node', inputSchema: { type: 'object' } }]));
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_node', arguments: {} } },
    ].map((m) => JSON.stringify(m)).join('\n');
    const out = spawnSync(python!, [containerScriptPath('mcp-stub.py'), path.join(dir, 'tools.json')], { input: `${input}\n`, encoding: 'utf8' });
    const answers = out.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(answers[0].result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'harness' } });
    expect(answers[1].result).toEqual({ tools: [{ name: 'ask_node', inputSchema: { type: 'object' } }] });
    expect(answers[2].result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/^Not available in sandbox mode/) }] });
  });
});

describe('a sandboxed reply (with a stand-in docker)', () => {
  const FAKE_CLI = path.join(import.meta.dirname, '..', 'llm', 'fake-claude.mjs');
  const FAKE_DOCKER = path.join(import.meta.dirname, '..', 'llm', 'fake-docker.mjs');
  const id = '00000000-0000-4000-8000-0000000000aa';
  let dir: string;
  let folder: string;
  let provider: ClaudeCodeProvider;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-sbx-'));
    folder = path.join(dir, 'project');
    mkdirSync(folder);
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'host-claude');
    process.env.FAKE_CLAUDE_LOG = path.join(dir, 'cli.jsonl');
    process.env.FAKE_DOCKER_LOG = path.join(dir, 'docker.jsonl');
    provider = new ClaudeCodeProvider({ command: process.execPath, prefixArgs: [FAKE_CLI], model: 'claude-opus-5-5', effort: 'high' });
  });
  afterEach(() => {
    provider.dispose();
    process.env = { ...saved };
  });

  const sandboxRun = (): SandboxRun => ({
    docker: { command: process.execPath, prefixArgs: [FAKE_DOCKER] },
    image: 'harness-sandbox:test',
    mounts: [{ source: folder, target: containerPath(folder), readonly: true }],
    secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
    env: { HOME: '/home/harness', CLAUDE_CONFIG_DIR: '/home/harness/.claude' },
    network: null,
    workDir: containerPath(folder),
    editDir: null,
    user: null,
    runsDir: path.join(dir, 'runs'),
    stubDir: path.join(dir, 'stub'),
    label: 'test',
  });
  const ctx = (message: string): ReplyContext => ({
    nodeId: 'n1', workDir: folder, message, request: { system: '', turns: [] }, model: null, effort: null, edit: null, mcpUrl: null,
    session: { mode: 'resume', sessionId: id, preamble: null, transcript: [] },
    sandbox: sandboxRun(),
  });

  it('runs the CLI through docker with its session copied in, and copies the session back after the turn', async () => {
    const hostSessions = sessionDir(process.env.CLAUDE_CONFIG_DIR!, folder);
    mkdirSync(hostSessions, { recursive: true });
    writeFileSync(path.join(hostSessions, `${id}.jsonl`), '{"type":"user","from":"host"}\n');

    const events: ReplyEvent[] = [];
    for await (const e of provider.streamReply(ctx('hello'), new AbortController().signal)) events.push(e);
    expect(events.find((e) => e.type === 'session')).toEqual({ type: 'session', sessionId: id });

    const docker = readFileSync(process.env.FAKE_DOCKER_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as {
      args: string[]; cliArgs: string[]; env: Record<string, string>; sessionIn: boolean;
    });
    expect(docker[0].sessionIn).toBe(true);
    expect(docker[0].args.join(' ')).not.toContain('sk-ant-oat01-test');
    expect(docker[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
    expect(docker[0].cliArgs).toEqual(expect.arrayContaining(['--resume', id, '--allowedTools']));
    // The session as the sandbox left it is back on this machine, before the reply counts as done.
    expect(readFileSync(path.join(hostSessions, `${id}.jsonl`), 'utf8')).toContain('"from":"sandbox"');
  });

  it('restarts the process when the node leaves the sandbox', async () => {
    const collect = async (c: ReplyContext) => {
      for await (const _ of provider.streamReply(c, new AbortController().signal)) { /* drain */ }
    };
    await collect(ctx('one'));
    await collect({ ...ctx('two'), sandbox: null });
    const cli = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv?: string[] });
    expect(cli.filter((e) => e.argv)).toHaveLength(2);
  });
});

/** Test certificates (made with openssl, valid until 2126): a CA like a VPN's, and a certificate that isn't a CA. */
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBzjCCAXOgAwIBAgIUP4F5WUEQNASCy5ee0KJf8KPeGnEwCgYIKoZIzj0EAwIw
OzEWMBQGA1UECgwNSGFybmVzcyBUZXN0czEhMB8GA1UEAwwYSGFybmVzcyBUZXN0
IFZQTiBSb290IENBMCAXDTI2MTExMjE5MTU0NVoYDzIxMjYxMDE5MTkxNTQ1WjA7
MRYwFAYDVQQKDA1IYXJuZXNzIFRlc3RzMSEwHwYDVQQDDBhIYXJuZXNzIFRlc3Qg
VlBOIFJvb3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR2NPc7pesINpte
RUFs5619dgeAM/NqPDwe2WLLVRlUpr/r0ItfMa+pU6A1DoDqEWSxs7WREy7U+mC3
Rgo53zz2o1MwUTAdBgNVHQ4EFgQUU9C4M9m7BQFeLl/4i2HDHT676ucwHwYDVR0j
BBgwFoAUU9C4M9m7BQFeLl/4i2HDHT676ucwDwYDVR0TAQH/BAUwAwEB/zAKBggq
hkjOPQQDAgNJADBGAiEAkmjCagUlTzW0IIDvksvDa/ytK40Mmg39KoBLmdGdp7YC
IQCx3Qz416TOPqTrv3XAFkCwLVhbpINHgiSu/qXKpkIMLQ==
-----END CERTIFICATE-----`;
const TEST_LEAF = `-----BEGIN CERTIFICATE-----
MIIBjDCCATKgAwIBAgIUXWI7ImmutBInWiYA+sReNcz8xH0wCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRSGFybmVzcyBUZXN0IExlYWYwIBcNMjYxMTEyMTkxNTQ1WhgP
MjEyNjEwMTkxOTE1NDVaMBwxGjAYBgNVBAMMEUhhcm5lc3MgVGVzdCBMZWFmMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbj991jwswbs9cg95bEoGtgzKXxlEBzA0
15VenMW21m9Js6PyYHBqggQPPYuRAI6ZHqeU2xVKNLe6DNF7Ns1soaNQME4wHQYD
VR0OBBYEFIIVSlGCY9JUt53MFZZw16wI7KuuMB8GA1UdIwQYMBaAFIIVSlGCY9JU
t53MFZZw16wI7KuuMAwGA1UdEwEB/wQCMAAwCgYIKoZIzj0EAwIDSAAwRQIhALym
/PCW3KbnqzcyCKH+aO3Vb0vAhuckth487i7PGF6nAiBt6WyvPMFAfPNFdPC9ZncE
iTvtHwHM0Wk98oAK8KQFPA==
-----END CERTIFICATE-----`;

describe("this machine's certificates", () => {
  const bundled = () => tls.getCACertificates('bundled');
  const publicRoot = bundled()[0];

  it('offers the valid CAs this machine trusts beyond the public ones, once each', () => {
    const found = hostCertificates({ system: () => [publicRoot, TEST_CA, TEST_LEAF, TEST_CA], extra: () => [], bundled });
    expect(found.map((c) => c.name)).toEqual(['Harness Test VPN Root CA']);
    expect(found[0]).toMatchObject({ issuer: 'Harness Test VPN Root CA', pem: TEST_CA });
    expect(found[0].fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('takes NODE_EXTRA_CA_CERTS too, leaves expired ones out, and survives a source that fails', () => {
    const fails = () => {
      throw new Error('no store');
    };
    expect(hostCertificates({ system: fails, extra: () => [TEST_CA], bundled }).map((c) => c.name)).toEqual(['Harness Test VPN Root CA']);
    expect(hostCertificates({ system: () => [TEST_CA], extra: () => [], bundled }, Date.parse('2200-01-01'))).toEqual([]);
  });

  it('a different set of certificates makes a different image', () => {
    expect(defaultImageTag('2.1.287', [TEST_CA])).not.toBe(defaultImageTag('2.1.287'));
    expect(certificateFiles([TEST_CA])).toEqual({ 'harness-ca/.keep': '', 'harness-ca/harness-001.crt': `${TEST_CA}\n` });
  });

  it('builds the image from a folder with the certificates, passing proxy variables by name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-build-'));
    const logFile = path.join(dir, 'docker.jsonl');
    // A docker that has no images yet and records each build: its arguments and the build folder.
    const fake = path.join(dir, 'docker.mjs');
    writeFileSync(fake, `import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'image') process.exit(1);
if (args[0] === 'build') {
  const context = args.at(-1);
  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
    args, files: readdirSync(context, { recursive: true }).map(String).sort(),
    dockerfile: readFileSync(context + '/Dockerfile', 'utf8'),
  }) + '\\n');
}
`);
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://user:secret@proxy.example:8080';
    try {
      const images = new SandboxImages({ command: process.execPath, prefixArgs: [fake] }, path.join(dir, 'build'));
      const tag = await images.ensure('p', { kind: 'default' }, '2.1.287', [TEST_CA]);
      expect(tag).toBe(defaultImageTag('2.1.287', [TEST_CA]));
      const [build] = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; files: string[]; dockerfile: string });
      expect(build.files.map((f) => f.replaceAll('\\', '/'))).toEqual(['Dockerfile', 'harness-ca', 'harness-ca/.keep', 'harness-ca/harness-001.crt']);
      expect(build.dockerfile).toContain('update-ca-certificates');
      expect(build.args).toEqual(expect.arrayContaining(['--build-arg', 'HTTPS_PROXY', '--build-arg', 'CLAUDE_VERSION=2.1.287']));
      expect(build.args.join(' ')).not.toContain('secret');
      // The build folder is gone afterwards.
      expect(existsSync(path.join(dir, 'build')) ? readdirSync(path.join(dir, 'build')) : []).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });
});

describe('keeping Docker and this machine out of reach', () => {
  it("refuses folders that hold Docker's socket, and the root", () => {
    const sockets = ['/var/run/docker.sock', '/home/ann/.docker/run/docker.sock'];
    expect(() => assertNoDockerSocket(['/home/ann/research'], sockets, 'linux')).not.toThrow();
    expect(() => assertNoDockerSocket(['/var/run'], sockets, 'linux')).toThrow(/Docker's socket/);
    expect(() => assertNoDockerSocket(['/home/ann'], sockets, 'linux')).toThrow(/Docker's socket/);
    expect(() => assertNoDockerSocket(['/home/ann/.docker/run/docker.sock'], sockets, 'linux')).toThrow(/Docker's socket/);
    expect(() => assertNoDockerSocket([path.parse(process.cwd()).root])).toThrow(/root/);
    expect(dockerSocketPaths({ DOCKER_HOST: 'unix:///custom/docker.sock' }, '/home/ann')).toContain('/custom/docker.sock');
  });

  it('never passes variables that point at Docker', () => {
    expect(['DOCKER_HOST', 'docker_cert_path', 'CONTAINER_HOST', 'PODMAN_HOST'].every(isDockerVariable)).toBe(true);
    expect(isDockerVariable('AWS_REGION')).toBe(false);
    expect(sandboxSettingsSchema.safeParse({ env: ['DOCKER_HOST'] }).success).toBe(false);
  });

  it("reaches the user's own proxy on this machine through host.docker.internal", () => {
    expect(upstreamProxy({ HTTPS_PROXY: 'http://user:pw@127.0.0.1:3128' })).toBe('http://user:pw@host.docker.internal:3128/');
    expect(upstreamProxy({ http_proxy: 'proxy.corp:8080' })).toBe('http://proxy.corp:8080/');
    expect(upstreamProxy({})).toBeNull();
  });

  it('points every program in the sandbox at the egress proxy', () => {
    const env = egressEnv();
    expect(env.HTTPS_PROXY).toBe(`http://${EGRESS_HOST}:${EGRESS_PORT}`);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    expect(env.NO_PROXY).toContain('localhost');
  });
});

describe('the egress proxy', () => {
  const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

  it('ships as files next to the code, copied with the tool definitions for the containers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-container-'));
    writeContainerFiles(dir, [{ name: 'ask_node' }]);
    expect(readFileSync(path.join(dir, 'egress-proxy.py'), 'utf8')).toBe(readFileSync(containerScriptPath('egress-proxy.py'), 'utf8'));
    expect(readFileSync(path.join(dir, 'mcp-stub.py'), 'utf8')).toContain('def main(tools_file)');
    expect(JSON.parse(readFileSync(path.join(dir, 'tools.json'), 'utf8'))).toEqual([{ name: 'ask_node' }]);
  });

  it.skipIf(!python)("refuses this machine, the local network and private addresses, and never connects there", async () => {
    // A service on this machine the proxy must not reach.
    let reached = 0;
    const target = net.createServer((s) => {
      reached++;
      s.end('HTTP/1.1 200 OK\r\n\r\nreached');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as net.AddressInfo).port;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proxy = spawn(python!, [containerScriptPath('egress-proxy.py'), String(port), EGRESS_HOST], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.stdout.on('data', (d: Buffer) => d.toString().includes('egress proxy on') && resolve());
        proxy.on('exit', () => reject(new Error('the proxy stopped')));
      });
      const ask = (request: string) => new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(request));
        let out = '';
        s.on('data', (d) => (out += d.toString()));
        s.on('close', () => resolve(out));
        s.on('error', () => resolve(out));
      });
      for (const host of ['127.0.0.1', 'localhost', 'host.docker.internal', '[::1]', '192.168.1.1', '10.0.0.1', '172.17.0.1', '169.254.169.254', '100.64.0.1', 'printer.local', EGRESS_HOST]) {
        const connect = await ask(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
        expect(connect, host).toMatch(/^HTTP\/1\.1 403/);
        const get = await ask(`GET http://${host}:${targetPort}/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        expect(get, host).toMatch(/^HTTP\/1\.1 403/);
        expect(get).toContain('are blocked');
      }
      expect(await ask('GET https://example.com/ HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
      expect(reached).toBe(0);
    } finally {
      proxy.kill();
      target.close();
    }
  });
});
