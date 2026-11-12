import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DockerState, SandboxBuild, SandboxImage } from '@harness/shared';
import { proxyVariables } from './certs.ts';

/** Harness's own sandbox image: Ubuntu, git, Python (for the MCP stub), and Claude Code at `CLAUDE_VERSION`. */
export const DEFAULT_DOCKERFILE = `# Harness's sandbox image: Ubuntu with Claude Code (the same version as on your machine).
FROM ubuntu:24.04
ARG CLAUDE_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep less \\
 && rm -rf /var/lib/apt/lists/*
# Certificates your machine trusts beyond the public ones (a VPN such as Cloudflare WARP, or a
# company network that inspects HTTPS): Harness puts them in the build folder, so HTTPS works from
# here on. Programs that keep their own list are pointed at the system's.
COPY harness-ca/ /usr/local/share/ca-certificates/harness/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \\
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \\
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \\
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION" \\
 && cp -L /root/.local/bin/claude /usr/local/bin/claude \\
 && rm -rf /root/.local /root/.claude /root/.claude.json \\
 && claude --version
RUN mkdir -p /home/harness && chmod 777 /home/harness
`;

/** What a project's own Dockerfile starts from (the dialog pre-fills it). */
export const CUSTOM_DOCKERFILE_START = `FROM harness-sandbox
# Add the tools your research needs, e.g.:
# RUN apt-get update && apt-get install -y --no-install-recommends texlive-latex-extra latexmk && rm -rf /var/lib/apt/lists/*
`;

/** The tag every project's own Dockerfile can start from (`FROM harness-sandbox`): the current default image. */
const BASE_NAME = 'harness-sandbox';

/**
 * Locate the docker command: HARNESS_DOCKER_PATH, then the usual install places (Docker Desktop
 * doesn't always put itself on PATH for programs started before it), else `docker` on PATH.
 */
export function findDocker(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HARNESS_DOCKER_PATH) return env.HARNESS_DOCKER_PATH;
  const candidates = platform === 'win32'
    ? [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      ]
    : platform === 'darwin'
      ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']
      : ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'];
  return candidates.find((file): file is string => !!file && existsSync(file)) ?? 'docker';
}

/**
 * The environment for docker commands: docker's own folder first on PATH. Docker Desktop keeps
 * helpers next to docker.exe (docker-credential-desktop, which even pulling a public image needs)
 * and finds them on PATH; a program started before Docker Desktop was installed doesn't have it.
 */
export function dockerEnv(command: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!path.isAbsolute(command)) return base;
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...base, [key]: [path.dirname(command), base[key]].filter(Boolean).join(path.delimiter) };
}

export interface DockerOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command could not be started (not installed). */
  missing: boolean;
}

/** Run a docker command; never throws. `onOutput` sees the output as it arrives (builds). */
export function runDocker(
  docker: { command: string; prefixArgs?: string[] },
  args: string[],
  options: { input?: string; timeoutMs?: number; onOutput?: (text: string) => void; env?: Record<string, string> } = {},
): Promise<DockerOutput> {
  return new Promise((resolve) => {
    const child = spawn(docker.command, [...(docker.prefixArgs ?? []), ...args], { windowsHide: true, env: dockerEnv(docker.command, { ...process.env, ...options.env }) });
    let stdout = '';
    let stderr = '';
    let missing = false;
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      options.onOutput?.(d.toString());
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      options.onOutput?.(d.toString());
    });
    child.on('error', (err) => {
      missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      stderr += err.message;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, missing });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** Whether Docker can run containers here, with advice when it can't. */
export async function dockerState(docker: { command: string; prefixArgs?: string[] }): Promise<{ state: DockerState; version: string | null; message: string | null }> {
  const out = await runDocker(docker, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  if (out.missing) {
    return { state: 'not-installed', version: null, message: 'Docker was not found. Install Docker Desktop (Windows, macOS) or Docker Engine (Linux), or set HARNESS_DOCKER_PATH to the docker command.' };
  }
  if (out.code === 0 && out.stdout.trim()) return { state: 'ready', version: out.stdout.trim(), message: null };
  return classifyDockerError(out.stderr);
}

/** What a failed docker command's error means for the user. */
export function classifyDockerError(stderr: string): { state: DockerState; version: null; message: string } {
  const text = stderr.trim();
  if (/permission denied/i.test(text) && /docker\.sock|docker API|daemon/i.test(text)) {
    return {
      state: 'no-permission',
      version: null,
      message: 'Docker is installed, but your user may not use it. Add yourself to the docker group (sudo usermod -aG docker $USER), then log out and back in (in WSL: wsl --shutdown), and restart Harness.',
    };
  }
  if (/cannot connect|failed to connect|is the docker daemon running|docker_engine|error during connect|no such file or directory/i.test(text)) {
    return { state: 'not-running', version: null, message: 'Docker is installed but not running. Start Docker Desktop (or the docker service) and try again.' };
  }
  return { state: 'error', version: null, message: `Docker did not answer: ${text.split('\n').slice(-2).join(' ') || 'no details'}` };
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The tag of the default image for this Claude Code version, this Dockerfile and these
 * certificates (a new or removed certificate means a new image).
 */
export function defaultImageTag(cliVersion: string, certificates: string[] = []): string {
  return `${BASE_NAME}:${cliVersion}-${hash([DEFAULT_DOCKERFILE, ...certificates].join('\n')).slice(0, 8)}`;
}

/** The build folder's certificate files (`harness-ca/*.crt`; a placeholder keeps the folder when there are none). */
export function certificateFiles(certificates: string[]): Record<string, string> {
  const files: Record<string, string> = { 'harness-ca/.keep': '' };
  certificates.forEach((pem, i) => {
    files[`harness-ca/harness-${String(i + 1).padStart(3, '0')}.crt`] = `${pem.trim()}\n`;
  });
  return files;
}

/** The tag of a project's own Dockerfile, built on top of `baseTag`. */
export function customImageTag(dockerfile: string, baseTag: string): string {
  return `${BASE_NAME}-custom:${hash(`${baseTag}\n${dockerfile}`).slice(0, 12)}`;
}

/** Why a build failed, in words the user can act on. */
export function buildError(log: string, code: number | null): string {
  if (/could not connect to|temporary failure resolving|could not resolve host|connection timed out|network is unreachable/i.test(log)) {
    return 'Building the sandbox image failed: containers can\'t reach the internet (and Claude Code in the sandbox couldn\'t reach Anthropic either). Check Docker\'s network settings; for example, "iptables": false in /etc/docker/daemon.json turns container networking off.';
  }
  const last = log.trim().split('\n').filter(Boolean).slice(-3).join(' ');
  return `Building the sandbox image failed: ${last || `exit code ${code}`}`;
}

/** Keep the end of a build's output. */
function tail(text: string, lines = 300): string {
  const all = text.split('\n');
  return all.length > lines ? all.slice(-lines).join('\n') : text;
}

/**
 * The sandbox images: built when first needed (or from the settings dialog), once per tag even if
 * several nodes ask at the same time. Each project remembers its last build for the dialog.
 */
export class SandboxImages {
  private readonly docker: { command: string; prefixArgs?: string[] };
  private readonly builds = new Map<string, Promise<void>>();
  private readonly byProject = new Map<string, SandboxBuild>();
  /** Where build folders are written (one per build, removed after it). */
  private readonly buildRoot: string;

  constructor(docker: { command: string; prefixArgs?: string[] }, buildRoot: string) {
    this.docker = docker;
    this.buildRoot = buildRoot;
  }

  buildState(projectId: string): SandboxBuild {
    return this.byProject.get(projectId) ?? { state: 'idle', image: null, log: '', error: null };
  }

  /**
   * The image a project's sandboxes run, built first if needed. `onBuild` is told when a build
   * starts (it can take minutes).
   */
  async ensure(projectId: string, image: SandboxImage, cliVersion: string, certificates: string[], onBuild?: () => void): Promise<string> {
    if (image.kind === 'image') {
      const found = await runDocker(this.docker, ['image', 'inspect', '--format', '{{.Id}}', image.name], { timeoutMs: 30_000 });
      if (found.code !== 0) throw new Error(`The sandbox image "${image.name}" was not found. Pull or build it first (docker pull ${image.name}).`);
      return image.name;
    }
    const base = defaultImageTag(cliVersion, certificates);
    await this.build(projectId, base, DEFAULT_DOCKERFILE, cliVersion, certificateFiles(certificates), onBuild);
    // `FROM harness-sandbox` means the current default image.
    await runDocker(this.docker, ['tag', base, BASE_NAME], { timeoutMs: 30_000 });
    if (image.kind === 'default') {
      this.byProject.set(projectId, { ...this.buildState(projectId), state: 'ready', image: base, error: null });
      return base;
    }
    const tag = customImageTag(image.dockerfile, base);
    await this.build(projectId, tag, image.dockerfile, cliVersion, {}, onBuild);
    this.byProject.set(projectId, { ...this.buildState(projectId), state: 'ready', image: tag, error: null });
    return tag;
  }

  /**
   * Build `tag` from `dockerfile` unless it exists. The build folder holds only the Dockerfile and
   * `files` (Harness's certificates), so a project's Dockerfile can't COPY anything else. Proxy
   * variables set for Harness are passed on (by name: docker reads their values itself).
   */
  private build(projectId: string, tag: string, dockerfile: string, cliVersion: string, files: Record<string, string>, onBuild?: () => void): Promise<void> {
    const running = this.builds.get(tag);
    if (running) {
      onBuild?.();
      return running;
    }
    const task = (async () => {
      const found = await runDocker(this.docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 30_000 });
      if (found.code === 0) return;
      onBuild?.();
      let log = '';
      const state: SandboxBuild = { state: 'building', image: tag, log: '', error: null };
      this.byProject.set(projectId, state);
      const context = path.join(this.buildRoot, hash(tag).slice(0, 16));
      rmSync(context, { recursive: true, force: true });
      for (const [name, text] of Object.entries({ Dockerfile: dockerfile, ...files })) {
        mkdirSync(path.dirname(path.join(context, name)), { recursive: true });
        writeFileSync(path.join(context, name), text);
      }
      const proxies = proxyVariables(process.env).flatMap((name) => ['--build-arg', name]);
      const out = await runDocker(
        this.docker,
        ['build', '--progress=plain', '--build-arg', `CLAUDE_VERSION=${cliVersion}`, ...proxies, '-t', tag, context],
        { onOutput: (text) => (state.log = log = tail(log + text)) },
      ).finally(() => rmSync(context, { recursive: true, force: true }));
      if (out.code !== 0) {
        const error = out.missing ? 'Docker was not found.' : buildError(state.log || out.stderr, out.code);
        this.byProject.set(projectId, { state: 'failed', image: tag, log: state.log, error });
        throw new Error(error);
      }
      this.byProject.set(projectId, { state: 'ready', image: tag, log: state.log, error: null });
    })().finally(() => this.builds.delete(tag));
    this.builds.set(tag, task);
    return task;
  }
}
