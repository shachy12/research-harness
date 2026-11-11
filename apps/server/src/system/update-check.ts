import type { VersionInfo } from '@harness/shared';

/** The npm package the app is published as (`npx research-harness`). */
export const NPM_PACKAGE = 'research-harness';

/** How often to ask npm for the latest version. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Asks the npm registry for the package's latest version now and every 30 minutes, so the UI can
 * say when a newer one is out. Only the running version is known to it (the npx package passes
 * it); nothing about the user is sent: a plain GET of the package's public `latest` entry.
 * Failures (offline, registry down) are logged once and leave the last answer in place.
 */
export class UpdateChecker {
  private readonly current: string;
  private readonly fetch: Fetch;
  private readonly intervalMs: number;
  private latest: string | null = null;
  private checkedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failing = false;

  constructor(current: string, { fetch: fetchFn = fetch as unknown as Fetch, intervalMs = UPDATE_CHECK_INTERVAL_MS } = {}) {
    this.current = current;
    this.fetch = fetchFn;
    this.intervalMs = intervalMs;
  }

  /** Check now, then every interval. The timer doesn't keep the process alive. */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the registry once. Returns the latest version, or null if the check failed. */
  async check(): Promise<string | null> {
    try {
      const res = await this.fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
      const { version } = (await res.json()) as { version?: unknown };
      if (typeof version !== 'string') throw new Error('the npm registry sent no version');
      this.latest = version;
      this.checkedAt = new Date().toISOString();
      this.failing = false;
      return version;
    } catch (err) {
      if (!this.failing) console.log(`[update check] could not reach npm: ${err instanceof Error ? err.message : String(err)}`);
      this.failing = true;
      return null;
    }
  }

  info(): VersionInfo {
    return {
      current: this.current,
      latest: this.latest,
      updateAvailable: this.latest !== null && isNewer(this.latest, this.current),
      checkedAt: this.checkedAt,
    };
  }
}

/**
 * Whether version `a` is newer than `b` (x.y.z, compared by number). A pre-release (`1.2.0-beta.1`)
 * never counts as newer: npm's `latest` tag is a release, and a pre-release one is better ignored.
 */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
    return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y || x.pre) return false;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i];
  return y.pre; // same numbers: a release is newer than its own pre-release
}
