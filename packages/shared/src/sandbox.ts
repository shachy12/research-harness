import { z } from 'zod/v4';

/**
 * Secure mode: a node marked `sandboxed` runs its Claude Code process inside a Docker container
 * that sees only the project folder (read-only), the node's own copy (writable) and what the
 * project's sandbox settings add. See apps/server/src/sandbox/.
 */

/** A folder of the user's machine the sandbox also sees (at the same path, converted for Linux). */
export const sandboxMountSchema = z.object({
  path: z.string().trim().min(1).max(1000),
  writable: z.boolean().default(false),
});

/**
 * Which image the sandbox runs: Harness's own (Ubuntu with the same Claude Code version as on
 * this machine), a Dockerfile of the project's (usually `FROM harness-sandbox` plus tools), or an
 * existing image (it must contain `claude` and `python3`).
 */
export const sandboxImageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({ kind: z.literal('dockerfile'), dockerfile: z.string().min(1).max(100_000) }),
  z.object({ kind: z.literal('image'), name: z.string().trim().min(1).max(300) }),
]);

/** A project's sandbox settings (`projects.sandbox`). */
export const sandboxSettingsSchema = z.object({
  image: sandboxImageSchema.default({ kind: 'default' }),
  /** Share `~/.aws` read-only (Bedrock). */
  shareAws: z.boolean().default(false),
  /** Names of environment variables passed from Harness's environment (their values stay out of the database). */
  env: z.array(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Not a valid variable name')
    // Whoever reaches Docker controls this machine: nothing that points at it goes in.
    .refine((name) => !/^(DOCKER_|PODMAN_)|^CONTAINER_HOST$/i.test(name), "Variables that point at Docker can't be passed into the sandbox"))
    .max(100).default([]),
  mounts: z.array(sandboxMountSchema).max(50).default([]),
  /** New roots of the project start sandboxed. */
  newNodes: z.boolean().default(false),
});

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
export type SandboxMount = z.infer<typeof sandboxMountSchema>;
export type SandboxImage = z.infer<typeof sandboxImageSchema>;

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = { image: { kind: 'default' }, shareAws: false, env: [], mounts: [], newNodes: false };

/** Turn secure mode on or off for a node's next replies. */
export const sandboxToggleSchema = z.object({ sandboxed: z.boolean() });

/** Certificates of this machine the sandbox image leaves out (by SHA-256 fingerprint); all others go in. */
export const sandboxCertificatesSchema = z.object({ excluded: z.array(z.string().trim().min(1).max(200)).max(1000) });

/** The Claude login token sandboxes use (from `claude setup-token`); null removes it. */
export const sandboxTokenSchema = z.object({ token: z.string().trim().min(10).max(2000).nullable() });

/** Variables that tell Claude Code how to log in or where to send requests, without a token. */
export const SANDBOX_AUTH_VARIABLES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** Whether Docker can be used, and if not, what the user can do about it. */
export type DockerState = 'ready' | 'not-installed' | 'not-running' | 'no-permission' | 'error';

/** GET /api/sandbox: can sandboxes run on this machine? */
export interface SandboxStatus {
  /** The provider can run in a sandbox at all (Claude Code; the placeholder only pretends). */
  supported: boolean;
  docker: { state: DockerState; version: string | null; message: string | null };
  /** Where the Claude login token comes from: saved in Harness, the environment, or none. */
  token: 'saved' | 'environment' | null;
  /** The Claude Code version the default image gets (the one on this machine). */
  cliVersion: string | null;
  /** Harness's own Dockerfile, as a starting point for a project's own. */
  defaultDockerfile: string;
  /**
   * Certificate authorities this machine trusts beyond the public ones (a VPN or company network
   * that inspects HTTPS installs one); the image trusts the included ones too. For all projects.
   */
  certificates: { fingerprint: string; name: string; issuer: string; validTo: string; included: boolean }[];
  /** Proxy variables set in Harness's environment, passed on to image builds and sandboxes. */
  proxy: string[];
}

/** GET /api/projects/:id/sandbox/build: the project's image being built, or the last build. */
export interface SandboxBuild {
  state: 'idle' | 'building' | 'ready' | 'failed';
  image: string | null;
  /** The end of the build output. */
  log: string;
  error: string | null;
}
