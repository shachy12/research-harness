import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isInside } from './paths.ts';

/**
 * What keeps Docker itself out of a sandbox's reach. Whoever can talk to Docker's API can start a
 * container that mounts this machine's disk, so it must never be reachable from a sandbox:
 *   - its socket is never mounted: no folder the sandbox sees may contain one (`assertNoDockerSocket`),
 *   - its TCP port (Docker Desktop's "expose daemon on tcp://localhost:2375") and every other service
 *     of this machine are behind the egress proxy (egress.ts), which refuses this machine's addresses,
 *   - variables that point at it (DOCKER_HOST, …) are never passed in (`isDockerVariable`).
 */

/** Where Docker's socket (and those of Docker-compatible engines) usually is. */
export function dockerSocketPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const unixHost = /^unix:\/\/(.+)$/.exec(env.DOCKER_HOST ?? '')?.[1];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/var/run/podman/podman.sock',
    '/run/podman/podman.sock',
    path.join(home, '.docker', 'run', 'docker.sock'), // Docker Desktop on macOS and Linux
    path.join(home, '.docker', 'desktop', 'docker.sock'),
    path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data'),
    path.join(home, '.colima'),
    path.join(home, '.orbstack', 'run', 'docker.sock'),
    path.join(home, '.rd', 'docker.sock'), // Rancher Desktop
    path.join(home, '.lima'),
    ...(env.XDG_RUNTIME_DIR ? [path.join(env.XDG_RUNTIME_DIR, 'docker.sock'), path.join(env.XDG_RUNTIME_DIR, 'podman', 'podman.sock')] : []),
    ...(uid !== null ? [`/run/user/${uid}/docker.sock`] : []),
    ...(unixHost ? [unixHost] : []),
  ];
}

/** A folder the sandbox must not see because Docker's socket is in it (or it is the socket). */
export class DockerSocketError extends Error {}

/**
 * Refuse folders that are, or contain, Docker's socket (a read-only mount doesn't help: connecting
 * to a socket ignores it), and the file system's root.
 */
export function assertNoDockerSocket(sources: string[], sockets: string[] = dockerSocketPaths(), platform: NodeJS.Platform = process.platform): void {
  for (const source of sources) {
    const real = existsSync(source) ? realpathSync(source) : source;
    if (path.parse(real).root === real) throw new DockerSocketError(`The sandbox can't see a whole drive or the file system's root (${source}).`);
    for (const socket of sockets) {
      if (isInside(socket, real, platform) || isInside(socket, source, platform)) {
        throw new DockerSocketError(`The sandbox can't see ${source}: Docker's socket is in it (${socket}), and with it a sandbox could control Docker and so this machine.`);
      }
    }
    try {
      if (lstatSync(real).isSocket()) throw new DockerSocketError(`The sandbox can't see ${source}: it is a socket.`);
    } catch (err) {
      if (err instanceof DockerSocketError) throw err;
    }
  }
}

/** Variables that point programs at Docker; never passed into a sandbox. */
export function isDockerVariable(name: string): boolean {
  return /^DOCKER_|^CONTAINER_HOST$|^PODMAN_/i.test(name);
}

/**
 * The user's own proxy (HTTPS_PROXY, else HTTP_PROXY, either case), for the egress proxy to go
 * through. A proxy on this machine (localhost) is reached at host.docker.internal from there:
 * only the egress proxy, Harness's own code, can reach this machine.
 */
export function upstreamProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) url.hostname = 'host.docker.internal';
    return url.toString();
  } catch {
    return null;
  }
}
