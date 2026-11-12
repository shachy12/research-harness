/**
 * The sandbox's only way out (the proxy itself: container/egress-proxy.py). Sandboxes sit on an
 * internal Docker network with no route to this machine, its local network or the internet. One
 * proxy container is on that network and on Docker's normal one; sandboxes reach it by its name
 * and get it as their HTTP(S) proxy. It forwards to public addresses only, so a sandboxed model
 * can't reach Harness's API, Docker's API or any other service of this machine or its network.
 * Started and kept by DockerSandbox.startEgress.
 */

/** The proxy container's name on the sandbox network. */
export const EGRESS_HOST = 'harness-egress';

/**
 * The port the proxy listens on inside its own container. Not a port of this machine: each
 * container has its own network stack, the proxy is the only program in its container, and the
 * port is never published (no `-p`), so nothing else can hold it. Sandboxes reach it by name.
 */
export const EGRESS_PORT = 3128;

/** The variables that point every program in a sandbox at the proxy (both spellings: tools differ). */
export function egressEnv(): Record<string, string> {
  const url = `http://${EGRESS_HOST}:${EGRESS_PORT}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: noProxy,
    http_proxy: url, https_proxy: url, all_proxy: url, no_proxy: noProxy,
  };
}
