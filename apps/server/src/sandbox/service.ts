import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type DagNode, type Project, SANDBOX_AUTH_VARIABLES, type SandboxBuild, type SandboxStatus } from '@harness/shared';
import type { SandboxRun } from '../llm/provider.ts';
import type { Workspaces } from '../workspace.ts';
import { type CertificateSources, type HostCertificate, hostCertificates, proxyVariables } from './certs.ts';
import { DEFAULT_DOCKERFILE, SandboxImages, dockerState, findDocker, runDocker } from './docker.ts';
import { EGRESS_HOST, EGRESS_PORT, egressEnv } from './egress.ts';
import { DockerSocketError, assertNoDockerSocket, isDockerVariable, upstreamProxy } from './isolation.ts';
import { containerPath, isInside, mountSpec } from './paths.ts';
import { STUB_DIR, containerScript, writeContainerFiles } from './stub.ts';

/** Inside the container: the home folder (a throwaway folder per run) and Claude's folder in it. */
export const CONTAINER_HOME = '/home/harness';

/** A sandbox can't run, for a reason the user can fix (shown as the reply's error). */
export class SandboxError extends Error {}

/** The node's copy, when the run may edit (see Worktrees.ensure). */
export interface SandboxCopy {
  /** The worktree's top folder (writable in the sandbox). */
  worktree: string;
  /** Where the model edits (the project folder inside the worktree). */
  editDir: string;
  /** The copy's git folder and the repository's (read-only). */
  gitAdmin: string;
  gitCommon: string;
}

/** What the app needs from the sandbox: whether it can run, and how to run one node's CLI. */
export interface Sandbox {
  status(): Promise<SandboxStatus>;
  /** How to run `node`'s CLI in a container. Builds the image first if needed (`onActivity` says so). */
  prepare(project: Project, node: DagNode, copy: SandboxCopy | null, onActivity: (text: string) => void): Promise<SandboxRun>;
  setToken(token: string | null): void;
  /** Leave these certificates of this machine (fingerprints) out of the image; all others go in. */
  setExcludedCertificates(excluded: string[]): void;
  /** Harness is stopping: remove what keeps running between replies (the egress proxy). */
  dispose?(): void;
  /** Start building the project's image now (the settings dialog's Build); progress in `buildState`. */
  build(project: Project): void;
  buildState(projectId: string): SandboxBuild;
}

export interface DockerSandboxOptions {
  dataDir: string;
  workspaces: Workspaces;
  /** The Claude Code version on this machine (the default image gets the same, so sessions match). */
  cliVersion: () => Promise<string | null>;
  /** The harness tools' definitions, for the MCP stub. */
  toolDefinitions: () => Promise<unknown[]>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The docker command (tests run a fake through node). */
  docker?: { command: string; prefixArgs?: string[] };
  /** Where this machine's certificates come from (tests pass their own). */
  certificates?: CertificateSources;
}

/** The certificates for the status, marked included unless excluded. */
function listCertificates(certs: HostCertificate[], excluded: Set<string>): SandboxStatus['certificates'] {
  return certs.map(({ fingerprint, name, issuer, validTo }) => ({ fingerprint, name, issuer, validTo, included: !excluded.has(fingerprint) }));
}

/**
 * Secure mode with Docker. A sandboxed node's CLI runs in a container that sees:
 *   - the project folder, read-only (its files, uploads, other nodes' copies, the repository),
 *   - the node's own copy, writable, with a read-only `.git` file of our own over the copy's
 *     (pointing at the repository's read-only git folder, at its container path),
 *   - a throwaway home folder with the one session it continues (sandbox/sessions.ts),
 *   - the MCP stub, and what the project's settings add (`~/.aws`, extra folders), and nothing
 *     else of this machine. The network is open (the CLI needs Anthropic's API, WebFetch the web).
 */
export class DockerSandbox implements Sandbox {
  private readonly options: DockerSandboxOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly docker: { command: string; prefixArgs?: string[] };
  private readonly images: SandboxImages;
  private readonly root: string;
  private readonly label: string;
  private stubReady: Promise<void> | null = null;
  private egressReady: Promise<string> | null = null;
  private cleaned = false;
  private lastState: { at: number; value: Awaited<ReturnType<typeof dockerState>> } | null = null;

  constructor(options: DockerSandboxOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.docker = options.docker ?? { command: findDocker(this.env, this.platform) };
    this.root = path.join(options.dataDir, 'sandbox');
    this.images = new SandboxImages(this.docker, path.join(this.root, 'build'));
    // One label per data folder: two Harness installs on one machine don't remove each other's containers.
    this.label = createHash('sha256').update(path.resolve(options.dataDir)).digest('hex').slice(0, 12);
    // Run folders of an earlier start are leftovers (their containers are gone or removed below).
    rmSync(path.join(this.root, 'runs'), { recursive: true, force: true });
  }

  private get tokenFile() {
    return path.join(this.root, 'claude-token');
  }

  /** The login token: saved in Harness (settings dialog), else CLAUDE_CODE_OAUTH_TOKEN in Harness's environment. */
  private token(): { value: string; source: 'saved' | 'environment' } | null {
    if (existsSync(this.tokenFile)) {
      const value = readFileSync(this.tokenFile, 'utf8').trim();
      if (value) return { value, source: 'saved' };
    }
    const fromEnv = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    return fromEnv ? { value: fromEnv, source: 'environment' } : null;
  }

  /** Machine-wide sandbox settings that aren't per project (`<data>/sandbox/settings.json`). */
  private get settingsFile() {
    return path.join(this.root, 'settings.json');
  }

  private excludedCertificates(): Set<string> {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as { excludedCertificates?: unknown };
      return new Set(Array.isArray(parsed.excludedCertificates) ? parsed.excludedCertificates.filter((f): f is string => typeof f === 'string') : []);
    } catch {
      return new Set();
    }
  }

  setExcludedCertificates(excluded: string[]): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.settingsFile, JSON.stringify({ excludedCertificates: [...new Set(excluded)] }, null, 2));
  }

  /** This machine's extra certificates the image trusts (PEM). Read from the OS each time: a VPN may have been installed since. */
  private includedCertificates(): string[] {
    const excluded = this.excludedCertificates();
    return hostCertificates(this.options.certificates).filter((c) => !excluded.has(c.fingerprint)).map((c) => c.pem);
  }

  setToken(token: string | null): void {
    if (token === null) {
      rmSync(this.tokenFile, { force: true });
      return;
    }
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.tokenFile, `${token.trim()}\n`, { mode: 0o600 });
    try {
      chmodSync(this.tokenFile, 0o600);
    } catch {
      // Windows: the user profile's permissions apply
    }
  }

  private async dockerReady() {
    // Asked on every status poll and run; Docker's answer is kept for a few seconds.
    if (this.lastState && Date.now() - this.lastState.at < 5000) return this.lastState.value;
    const value = await dockerState(this.docker);
    this.lastState = { at: Date.now(), value };
    if (value.state === 'ready' && !this.cleaned) {
      this.cleaned = true;
      await this.removeLeftovers();
    }
    return value;
  }

  /** Containers of this app left from an earlier start (the server stopped while they ran). */
  private async removeLeftovers(): Promise<void> {
    const out = await runDocker(this.docker, ['ps', '-aq', '--filter', `label=harness.sandbox=${this.label}`], { timeoutMs: 30_000 });
    const ids = out.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await runDocker(this.docker, ['rm', '-f', ...ids], { timeoutMs: 60_000 });
  }

  async status(): Promise<SandboxStatus> {
    const [docker, cliVersion] = await Promise.all([this.dockerReady(), this.options.cliVersion()]);
    return {
      supported: true, docker, token: this.token()?.source ?? null, cliVersion, defaultDockerfile: DEFAULT_DOCKERFILE,
      certificates: listCertificates(hostCertificates(this.options.certificates), this.excludedCertificates()),
      proxy: proxyVariables(this.env),
    };
  }

  buildState(projectId: string): SandboxBuild {
    return this.images.buildState(projectId);
  }

  build(project: Project): void {
    void this.image(project).catch((err: unknown) => console.error(`[sandbox] build for ${project.id}:`, err));
  }

  private async image(project: Project, onBuild?: () => void): Promise<string> {
    const docker = await this.dockerReady();
    if (docker.state !== 'ready') throw new SandboxError(docker.message ?? 'Docker is not available.');
    const version = await this.options.cliVersion();
    if (!version && project.sandbox.image.kind !== 'image') {
      throw new SandboxError('Could not tell which Claude Code version is installed (claude --version failed), so the sandbox image can\'t match it.');
    }
    return this.images.ensure(project.id, project.sandbox.image, version ?? '', this.includedCertificates(), onBuild);
  }

  async prepare(project: Project, node: DagNode, copy: SandboxCopy | null, onActivity: (text: string) => void): Promise<SandboxRun> {
    const settings = project.sandbox;
    const secretEnv: Record<string, string> = {};
    for (const name of settings.env) {
      const value = this.env[name];
      // Never anything that points at Docker; proxy variables are the egress proxy's (below).
      if (value !== undefined && !isDockerVariable(name) && !proxyVariables({ [name]: value }).length) secretEnv[name] = value;
    }
    const token = this.token();
    if (token && !secretEnv.CLAUDE_CODE_OAUTH_TOKEN) secretEnv.CLAUDE_CODE_OAUTH_TOKEN = token.value;
    if (!SANDBOX_AUTH_VARIABLES.some((name) => secretEnv[name])) {
      throw new SandboxError('The sandbox has no Claude login. Run `claude setup-token` in a terminal and paste the token in Sandbox settings (or pass your Bedrock/Vertex variables there).');
    }

    const image = await this.image(project, () => onActivity('Building the sandbox image (the first time takes a few minutes)'));
    onActivity('Starting the sandbox');
    await (this.stubReady ??= this.options.toolDefinitions().then((tools) => writeContainerFiles(path.join(this.root, 'stub'), tools)));
    const network = await this.egress(project);

    const cp = (p: string) => containerPath(p, this.platform);
    const folder = path.resolve(this.options.workspaces.prepare(project));
    const mounts: SandboxRun['mounts'] = [{ source: folder, target: cp(folder), readonly: true }];
    if (copy) {
      mounts.push({ source: copy.worktree, target: cp(copy.worktree), readonly: false });
      // The copy's `.git` file, as the container must read it (the real one may hold a Windows
      // path), read-only: the model can't point its git anywhere else.
      const gitFile = path.join(this.root, 'git-files', `${node.id}.git`);
      mkdirSync(path.dirname(gitFile), { recursive: true });
      writeFileSync(gitFile, `gitdir: ${cp(copy.gitAdmin)}\n`);
      mounts.push({ source: gitFile, target: `${cp(copy.worktree)}/.git`, readonly: true });
      // A repository above the project folder: its git folder isn't in the project folder's mount.
      if (!isInside(copy.gitCommon, folder, this.platform)) mounts.push({ source: copy.gitCommon, target: cp(copy.gitCommon), readonly: true });
    }
    if (settings.shareAws) {
      const aws = path.join(homedir(), '.aws');
      if (!existsSync(aws)) throw new SandboxError(`Sandbox settings share ~/.aws, but ${aws} doesn't exist.`);
      mounts.push({ source: aws, target: `${CONTAINER_HOME}/.aws`, readonly: true });
    }
    for (const m of settings.mounts) {
      const source = path.resolve(m.path);
      if (!existsSync(source) || !statSync(source).isDirectory()) throw new SandboxError(`The folder "${m.path}" in Sandbox settings doesn't exist.`);
      mounts.push({ source, target: cp(source), readonly: !m.writable });
    }
    try {
      assertNoDockerSocket(mounts.map((m) => m.source), undefined, this.platform);
    } catch (err) {
      if (err instanceof DockerSocketError) throw new SandboxError(err.message);
      throw err;
    }

    return {
      docker: this.docker,
      image,
      mounts,
      secretEnv,
      env: {
        HOME: CONTAINER_HOME,
        CLAUDE_CONFIG_DIR: `${CONTAINER_HOME}/.claude`,
        CLAUDE_CODE_TETHER_LIVE: 'false', // see cliEnv
        DISABLE_AUTOUPDATER: '1',
        // The project's files belong to another user inside the container; let git read them anyway.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
        // The only way out (see egress.ts).
        ...egressEnv(),
      },
      network,
      workDir: cp(folder),
      editDir: copy ? cp(copy.editDir) : null,
      user: this.platform === 'win32' || typeof process.getuid !== 'function' ? null : `${process.getuid()}:${process.getgid!()}`,
      runsDir: path.join(this.root, 'runs'),
      stubDir: path.join(this.root, 'stub'),
      label: this.label,
    };
  }

  /**
   * The sandbox network and its egress proxy, created if needed: an internal network (no route
   * anywhere) and a proxy container on it and on Docker's normal network, running as nobody on a
   * read-only file system without capabilities. It runs from Harness's own image (it needs only
   * Python). Recreated when the proxy, its image or the user's upstream proxy changes, or after it
   * stopped. Returns the network's name.
   */
  private egress(project: Project): Promise<string> {
    const task = (this.egressReady ??= this.startEgress(project).finally(() => (this.egressReady = null)));
    return task;
  }

  private async startEgress(project: Project): Promise<string> {
    const docker = this.docker;
    const network = `harness-sandbox-${this.label}`;
    const name = `harness-egress-${this.label}`;
    const version = await this.options.cliVersion();
    const image = await this.images.ensure(project.id, { kind: 'default' }, version ?? '', this.includedCertificates());
    const upstream = upstreamProxy(this.env);
    const stamp = createHash('sha256').update([containerScript('egress-proxy.py'), image, upstream ?? ''].join('\n')).digest('hex').slice(0, 16);

    if ((await runDocker(docker, ['network', 'inspect', network], { timeoutMs: 30_000 })).code !== 0) {
      const made = await runDocker(docker, ['network', 'create', '--internal', '--label', `harness.sandbox=${this.label}`, network], { timeoutMs: 60_000 });
      if (made.code !== 0 && !/already exists/i.test(made.stderr)) throw new SandboxError(`Could not create the sandbox network: ${made.stderr.trim()}`);
    }
    const state = await runDocker(docker, ['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "harness.egress"}}', name], { timeoutMs: 30_000 });
    if (state.code === 0 && state.stdout.trim() === `true ${stamp}`) return network;

    await runDocker(docker, ['rm', '-f', name], { timeoutMs: 60_000 });
    const started = await runDocker(docker, [
      'run', '-d', '--name', name,
      '--label', `harness.sandbox=${this.label}`, '--label', `harness.egress=${stamp}`,
      '--user', '65534:65534', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', mountSpec({ source: path.join(this.root, 'stub'), target: STUB_DIR, readonly: true }),
      // The user's proxy (its address may hold a password: passed by name).
      ...(upstream ? ['-e', 'EGRESS_UPSTREAM', '--add-host', 'host.docker.internal:host-gateway'] : []),
      image, 'python3', `${STUB_DIR}/egress-proxy.py`, String(EGRESS_PORT), EGRESS_HOST,
    ], { timeoutMs: 120_000, env: upstream ? { EGRESS_UPSTREAM: upstream } : undefined });
    if (started.code !== 0) throw new SandboxError(`Could not start the sandbox's proxy: ${started.stderr.trim().split('\n').at(-1)}`);
    const joined = await runDocker(docker, ['network', 'connect', '--alias', EGRESS_HOST, network, name], { timeoutMs: 60_000 });
    if (joined.code !== 0) throw new SandboxError(`Could not connect the sandbox's proxy: ${joined.stderr.trim()}`);
    // Wait until it listens (Python starts in a moment); if it stops instead, say why.
    const output = async () => {
      const logs = await runDocker(docker, ['logs', '--tail', '20', name], { timeoutMs: 10_000 });
      return `${logs.stdout}${logs.stderr}`.trim();
    };
    const lastLines = (text: string) => text.split('\n').slice(-3).join(' ') || 'no output';
    for (let i = 0; i < 50; i++) {
      const text = await output();
      if (text.includes('egress proxy on')) return network;
      const running = await runDocker(docker, ['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
      if (running.stdout.trim() !== 'true') throw new SandboxError(`The sandbox's proxy stopped: ${lastLines(text)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new SandboxError(`The sandbox's proxy did not start within 5 seconds: ${lastLines(await output())}`);
  }

  dispose(): void {
    void runDocker(this.docker, ['rm', '-f', `harness-egress-${this.label}`], { timeoutMs: 30_000 });
  }
}

/**
 * The placeholder provider's sandbox (previews, tests): always ready, runs nothing. The toggle,
 * the notes and the "written in the sandbox" marks can be tried without Docker.
 */
export class FakeSandbox implements Sandbox {
  private token: string | null = 'placeholder';
  private excluded = new Set<string>();

  async status(): Promise<SandboxStatus> {
    return {
      supported: true,
      docker: { state: 'ready', version: 'placeholder', message: null },
      token: this.token ? 'saved' : null,
      cliVersion: null,
      defaultDockerfile: DEFAULT_DOCKERFILE,
      // This machine's real certificates, so the dialog can be tried in the preview.
      certificates: listCertificates(hostCertificates(), this.excluded),
      proxy: proxyVariables(process.env),
    };
  }

  async prepare(project: Project, _node: DagNode, copy: SandboxCopy | null): Promise<SandboxRun> {
    const folder = project.folder ?? '/project';
    return {
      docker: { command: 'docker' },
      image: 'placeholder',
      mounts: [],
      secretEnv: {},
      env: {},
      network: null,
      workDir: containerPath(folder),
      editDir: copy ? containerPath(copy.editDir) : null,
      user: null,
      runsDir: '',
      stubDir: '',
      label: 'placeholder',
    };
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  setExcludedCertificates(excluded: string[]): void {
    this.excluded = new Set(excluded);
  }

  build(): void {}

  buildState(): SandboxBuild {
    return { state: 'ready', image: 'placeholder', log: '', error: null };
  }
}
