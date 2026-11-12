/**
 * Live check of secure mode with the real Docker (and, with a login token, the real CLI).
 *   npm run check:sandbox -w @harness/server [-- <model>]     (default model: claude-haiku-4-5)
 *
 * Without a token it checks everything up to the model: the image builds, and inside a container
 * started exactly as for a sandboxed reply, the project folder is read-only, the node's copy is
 * writable, its git works but `.git` can't be changed, the MCP stub lists the harness tools and
 * refuses them, and a session comes back to this machine. With CLAUDE_CODE_OAUTH_TOKEN set (from
 * `claude setup-token`; uses a little of your usage limit) it also runs real replies in the
 * sandbox: a file written in the copy, a write outside refused, the stub's refusal, and the session
 * continued on this machine afterwards.
 *
 * Uses a scratch data folder, so the app's data and images are separate (the first run builds the
 * image, a few minutes). Exits with code 1 if a check fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SANDBOX_SETTINGS, type DagNode, type Project } from '@harness/shared';
import type { SessionPlan } from '../dag/session.ts';
import { ClaudeCodeProvider, dockerRunArgs, findClaudeExecutable } from '../llm/claude-code.ts';
import type { ReplyContext, ReplyEvent, SandboxRun } from '../llm/provider.ts';
import { dockerEnv, runDocker } from '../sandbox/docker.ts';
import { copySessionBack, hostClaudeDir } from '../sandbox/sessions.ts';
import { DockerSandbox } from '../sandbox/service.ts';
import { harnessToolDefinitions } from '../tools/harness.ts';
import { Workspaces } from '../workspace.ts';
import { Worktrees } from '../worktrees.ts';
import { GraphSnapshot } from '../dag/graph.ts';

const model = process.argv[2] ?? 'claude-haiku-4-5';
process.env.HARNESS_ISOLATE_CLAUDE_ENV = '1';
const dataDir = mkdtempSync(path.join(tmpdir(), 'harness-sandbox-check-'));
const folder = path.join(dataDir, 'project');
mkdirSync(folder, { recursive: true });
writeFileSync(path.join(folder, 'notes.md'), '# Notes\nThe secret word is "marmalade".\n');

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed = true;
}

const provider = new ClaudeCodeProvider({ command: findClaudeExecutable(), model, effort: 'low' });
const workspaces = new Workspaces(dataDir);
const worktrees = new Worktrees(workspaces);
const sandbox = new DockerSandbox({ dataDir, workspaces, cliVersion: () => provider.cliVersion(), toolDefinitions: harnessToolDefinitions });

const status = await sandbox.status();
console.log(`docker: ${status.docker.state} ${status.docker.version ?? ''} ${status.docker.message ?? ''}`);
console.log(`claude on this machine: ${status.cliVersion}`);
if (status.docker.state !== 'ready') process.exit(2);

const project: Project = { id: 'check', name: 'Sandbox check', folder, archived: false, sandbox: DEFAULT_SANDBOX_SETTINGS, createdAt: '' };
const node: DagNode = {
  id: 'abcdef12-0000-4000-8000-000000000001', projectId: 'check', title: 'Check', titleSource: 'prompt', promptTitle: 'Check', parentIds: [],
  forkPoint: null, forkSession: null, status: 'open', result: null, resultUpto: null, mergeResults: null, mergePrompt: null,
  filesFromProject: false, targetBranch: null, compact: false, compactText: null, sessionId: null, readUpto: null, model: null,
  effort: null, gitBranch: null, filesChanged: null, sandboxed: true, createdAt: '',
};
await worktrees.setUp(project);
const copy = await worktrees.ensure(project, new GraphSnapshot([node], []), node);

// Without a token the checks below still run; `prepare` needs some login, so give it a dummy one.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) sandbox.setToken('sk-ant-oat01-dummy-for-the-checks-without-a-model');
console.log('preparing the sandbox (builds the image the first time)...');
const started = Date.now();
const run: SandboxRun = await sandbox.prepare(project, node, copy, (text) => console.log(`  ${text}`));
console.log(`image ${run.image} ready after ${Math.round((Date.now() - started) / 1000)} s`);

/** Run a shell script in a container started exactly as for this node's replies (or as `r` says). */
function inSandbox(script: string, input = '', r: SandboxRun = run): { code: number | null; out: string } {
  const home = mkdtempSync(path.join(dataDir, 'home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const args = dockerRunArgs(r, { name: `harness-check-${Date.now()}`, home, cliArgs: [] });
  // Swap the CLI for a shell.
  args.splice(args.lastIndexOf('claude'), 1, 'bash', '-c', script);
  const out = spawnSync(run.docker.command, args, { input, encoding: 'utf8', env: dockerEnv(run.docker.command, { ...process.env, ...run.secretEnv }) });
  return { code: out.status, out: `${out.stdout}${out.stderr}`.trim() };
}

const editDir = run.editDir!;
check('reads the project folder', inSandbox(`cat ${run.workDir}/notes.md`).out.includes('marmalade'));
check('the project folder is read-only', inSandbox(`echo x > ${run.workDir}/new.txt`).code !== 0);
check('writes in its copy', inSandbox(`echo hello > ${editDir}/hello.txt && cat ${editDir}/hello.txt`).out === 'hello');
check('the file is in the copy on this machine', existsSync(path.join(copy.editDir, 'hello.txt')));
const gitStatus = inSandbox(`cd ${editDir} && git status --short && git log --oneline | head -1`);
check('git works in its copy', gitStatus.code === 0 && gitStatus.out.includes('hello.txt'), gitStatus.out.split('\n').slice(-2).join(' | '));
check("its .git file can't be changed", inSandbox(`echo 'gitdir: /tmp/evil' > ${editDir}/.git`).code !== 0);
check("the repository's config can't be changed", inSandbox(`cd ${editDir} && git config core.fsmonitor 'touch /tmp/x'`).code !== 0);
check("git can't commit (Harness commits from outside)", inSandbox(`cd ${editDir} && git add -A && git -c user.name=x -c user.email=x@x commit -qm x`).code !== 0);
check("this machine's home folder isn't there", inSandbox(`ls ${path.posix.dirname(run.workDir)} 2>/dev/null | wc -l; test ! -e /c/Users/${process.env.USERNAME ?? 'x'}/.ssh && test ! -e ${process.env.HOME ?? '/nonexistent'}/.ssh`).code === 0);

const rpc = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_node', arguments: { nodeId: 'x', question: 'y' } } },
].map((m) => JSON.stringify(m)).join('\n');
const stub = inSandbox('python3 /opt/harness/mcp-stub.py /opt/harness/tools.json', `${rpc}\n`);
const answers = stub.out.split('\n').flatMap((l) => {
  try {
    return [JSON.parse(l) as { id: number; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }];
  } catch {
    return [];
  }
});
const listed = answers.find((a) => a.id === 2)?.result?.tools?.map((t) => t.name) ?? [];
check('the MCP stub lists the harness tools', listed.join(',') === 'fork_branches,ask_node', listed.join(','));
const refused = answers.find((a) => a.id === 3)?.result;
check('the MCP stub refuses them', refused?.isError === true && !!refused.content?.[0]?.text.startsWith('Not available in sandbox mode'));

// The network: no way out but the egress proxy, which refuses this machine (Harness, Docker's API,
// anything on localhost) and the local network.
{
  const local = createServer((_, res) => res.end('reached this machine'));
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  const port = (local.address() as AddressInfo).port;
  const out = inSandbox([
    `echo "direct: $(curl --noproxy '*' -s -m 8 -o /dev/null -w %{http_code} https://example.com || echo blocked)"`,
    `echo "proxied: $(curl -s -m 30 -o /dev/null -w %{http_code} https://example.com || echo failed)"`,
    `echo "host direct: $(curl --noproxy '*' -s -m 5 http://host.docker.internal:${port}/ || echo blocked)"`,
    `echo "host proxied: $(curl -s -m 10 http://host.docker.internal:${port}/ || echo failed)"`,
    `echo "docker tcp: $(curl -s -m 5 http://host.docker.internal:2375/version || echo failed) / $(curl --noproxy '*' -s -m 5 http://host.docker.internal:2375/version || echo blocked)"`,
    `echo "lan: $(curl -s -m 10 http://192.168.1.1/ || echo failed)"`,
    `echo "docker socket: $(ls /var/run/docker.sock /run/docker.sock 2>/dev/null || echo none)"`,
    `echo "git: $(git ls-remote https://github.com/git/git HEAD >/dev/null 2>&1 && echo ok || echo failed)"`,
    `echo "claude: $(CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid timeout 60 claude -p hi --model claude-haiku-4-5 2>&1 | tail -1)"`,
  ].join('; ')).out;
  local.close();
  const line = (key: string) => out.split('\n').find((l) => l.startsWith(`${key}:`)) ?? `${key}: (no output)`;
  check('no direct way to the internet', line('direct') === 'direct: 000blocked', line('direct'));
  check('the internet through the egress proxy', line('proxied') === 'proxied: 200', line('proxied'));
  check("no direct way to this machine's localhost", line('host direct').endsWith('blocked'), line('host direct'));
  check("the proxy refuses this machine's localhost", line('host proxied').includes('are blocked'), line('host proxied'));
  check("Docker's TCP port is out of reach", !line('docker tcp').includes('ApiVersion') && line('docker tcp').includes('are blocked'), line('docker tcp'));
  check('the proxy refuses the local network', line('lan').includes('are blocked'), line('lan'));
  check("Docker's socket isn't there", line('docker socket') === 'docker socket: none', line('docker socket'));
  check('git works through the proxy', line('git') === 'git: ok', line('git'));
  check('Claude Code reaches Anthropic through the proxy (a login error, not a connection error)',
    /401|authenticat|invalid|login/i.test(line('claude')) && !/unable to connect|ECONNREFUSED|ENOTFOUND|timed out/i.test(line('claude')), line('claude').slice(0, 160));
}

// A session written in the sandbox comes back; a broken one doesn't.
const sessionId = '0f0f0f0f-1111-4222-8333-444455556666';
const home = mkdtempSync(path.join(dataDir, 'session-'));
const inside = { claudeDir: path.join(home, '.claude'), workDir: run.workDir };
const host = { claudeDir: path.join(dataDir, 'host-claude'), workDir: folder };
const sessions = path.join(inside.claudeDir, 'projects', run.workDir.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(sessions, { recursive: true });
writeFileSync(path.join(sessions, `${sessionId}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n');
check('a session comes back to this machine', copySessionBack(sessionId, inside, host));
writeFileSync(path.join(sessions, `${sessionId}.jsonl`), '{"type":"user"}\nnot json\n');
check("a broken session doesn't", !copySessionBack(sessionId, inside, host));

// Certificates, as on a VPN that inspects HTTPS (Cloudflare WARP and the like): a throwaway CA
// (made with openssl in the image) is handed to the sandbox as if this machine trusted it. In an
// image built with it, curl and Claude Code accept a server whose certificate that CA signed; in
// the image without it, they refuse.
{
  console.log('\ncertificates: building an image that trusts a throwaway CA...');
  const caDir = mkdtempSync(path.join(dataDir, 'ca-'));
  const caMount = { source: caDir, target: '/ca', readonly: false };
  const make = inSandbox([
    'set -e; cd /ca',
    'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=Harness Check Root CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"',
    'openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=localhost"',
    'printf "subjectAltName=DNS:localhost\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n" > ext.cnf',
    'openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 2 -extfile ext.cnf',
  ].join(' && '), '', { ...run, mounts: [...run.mounts, caMount] });
  check('made a throwaway CA', make.code === 0 && existsSync(path.join(caDir, 'leaf.pem')), make.out.split('\n').slice(-2).join(' | '));

  const withCa = new DockerSandbox({
    dataDir, workspaces, cliVersion: () => provider.cliVersion(), toolDefinitions: harnessToolDefinitions,
    certificates: {
      system: () => tls.getCACertificates('system'),
      extra: () => [readFileSync(path.join(caDir, 'ca.pem'), 'utf8')],
      bundled: () => tls.getCACertificates('bundled'),
    },
  });
  check('the CA is offered as one of this machine\'s certificates', (await withCa.status()).certificates.some((c) => c.name === 'Harness Check Root CA' && c.included));
  const trusting = await withCa.prepare(project, node, null, (text) => console.log(`  ${text}`));
  check('it makes a different image', trusting.image !== run.image, trusting.image);

  // A server with the CA-signed certificate on localhost, then curl and Claude Code against it.
  const probe = [
    // -state logs each handshake; "read finished" means the client accepted the certificate.
    'openssl s_server -accept 4433 -cert /ca/leaf.pem -key /ca/leaf.key -www -state >/tmp/server.log 2>&1 & sleep 1',
    'echo "curl: $(curl -s -o /dev/null -w "%{http_code}" https://localhost:4433/ || echo failed)"',
    ': > /tmp/server.log',
    // The test server isn't an API, so Claude Code keeps retrying: what counts is the handshake.
    'echo "claude: $(ANTHROPIC_BASE_URL=https://localhost:4433 timeout 20 claude -p hi --model claude-haiku-4-5 2>&1 | tail -2 | tr "\\n" " ")"',
    'echo "handshakes: $(grep -ac "read finished" /tmp/server.log)"',
  ].join('; ');
  const mounted = (r: SandboxRun): SandboxRun => ({ ...r, mounts: [...r.mounts, { ...caMount, readonly: true }] });
  const good = inSandbox(probe, '', mounted(trusting)).out;
  const bad = inSandbox(probe, '', mounted({ ...run, editDir: null })).out;
  const line = (out: string, key: string) => out.split('\n').find((l) => l.startsWith(`${key}:`)) ?? '';
  check('curl trusts the CA in that image', line(good, 'curl') === 'curl: 200', line(good, 'curl'));
  check('curl refuses it in the image without', line(bad, 'curl') !== 'curl: 200', line(bad, 'curl'));
  check('Claude Code trusts the CA in that image (completed TLS handshakes)', line(good, 'handshakes') !== 'handshakes: 0' && line(good, 'handshakes') !== '', line(good, 'handshakes'));
  check('Claude Code refuses it in the image without', line(bad, 'handshakes') === 'handshakes: 0' && /certificate/i.test(line(bad, 'claude')), line(bad, 'claude').slice(0, 160));
  // That image trusts a CA whose key was in a temporary folder: don't keep it.
  await runDocker(run.docker, ['rmi', '-f', trusting.image], { timeoutMs: 60_000 });
  // Building it also made it `harness-sandbox` (what project Dockerfiles start FROM): point that back.
  await runDocker(run.docker, ['tag', run.image, 'harness-sandbox'], { timeoutMs: 60_000 });
}

if (!token) {
  console.log('\nNo CLAUDE_CODE_OAUTH_TOKEN: skipped the replies with the real CLI (run `claude setup-token`, set the variable, run again).');
} else {
  const NEW: SessionPlan = { mode: 'new', sessionId: null, preamble: null, transcript: [] };
  const ctx = (message: string, session: SessionPlan, sandboxed: boolean): ReplyContext => ({
    nodeId: node.id, workDir: folder, message, session, request: { system: '', turns: [] }, model, effort: null,
    edit: { dir: copy.editDir }, mcpUrl: null, sandbox: sandboxed ? run : null,
  });
  const collect = async (events: AsyncIterable<ReplyEvent>) => {
    const out: ReplyEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  };
  const textOf = (events: ReplyEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const signal = new AbortController().signal;

  const first = await collect(provider.streamReply(ctx(
    `Use the Bash tool to run exactly these two commands, one at a time, then call the ask_node tool with nodeId "x" and question "y", then reply with one line: the word from notes.md and what ask_node answered.\n1. echo sandboxed > ${editDir}/from-model.txt\n2. echo bad > ${run.workDir}/outside.txt\nThe word is in ${run.workDir}/notes.md.`,
    NEW, true), signal));
  const session = first.find((e) => e.type === 'session')?.sessionId;
  check('a reply runs in the sandbox', !!session && textOf(first).length > 0, textOf(first).slice(0, 200));
  check('it wrote in its copy', readFileSync(path.join(copy.editDir, 'from-model.txt'), 'utf8').trim() === 'sandboxed');
  check('its write outside failed', !existsSync(path.join(folder, 'outside.txt')));
  const ask = first.find((e) => e.type === 'tool' && e.call.name === 'ask_node' && e.call.status !== 'running');
  check('ask_node was refused by the stub', ask?.type === 'tool' && ask.call.status === 'error');
  check('the session came back', !!session && existsSync(path.join(hostClaudeDir(), 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)));
  provider.release(node.id);

  const second = await collect(provider.streamReply(ctx('Which word did notes.md contain? Answer with the word only.', { mode: 'resume', sessionId: session!, preamble: null, transcript: [] }, false), signal));
  check('the session goes on outside the sandbox', textOf(second).toLowerCase().includes('marmalade'), textOf(second).slice(0, 100));
  provider.dispose();
}

// The scratch data folder's proxy and network.
if (run.network) {
  await runDocker(run.docker, ['rm', '-f', run.network.replace('harness-sandbox-', 'harness-egress-')], { timeoutMs: 60_000 });
  await runDocker(run.docker, ['network', 'rm', run.network], { timeoutMs: 60_000 });
}
console.log(`\nscratch data folder: ${dataDir}`);
process.exit(failed ? 1 : 0);
