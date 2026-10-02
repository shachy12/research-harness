import type { ErrorKind } from '@harness/shared';

/**
 * A model call failed for a reason the user should see plainly: the usage limit was reached, the
 * login is missing, a billing problem, or something else. `message` is written for the user.
 */
export class ProviderError extends Error {
  readonly kind: ErrorKind;
  /** When a usage limit resets (ISO time), if the provider said. */
  readonly resetsAt: string | null;

  constructor(kind: ErrorKind, message: string, resetsAt: string | null = null) {
    super(message);
    this.kind = kind;
    this.resetsAt = resetsAt;
  }
}

const USAGE_LIMIT = /hit your (?:\w+ )?limit|usage limit|limit reached|reached your (?:\w+ )?limit|rate.?limit|out of (?:extra )?usage|credits? (?:used up|exhausted|ran out|run out)/i;
const AUTH = /not logged in|please (?:run )?\/?login|log ?in (?:again|first)|authenticat|invalid (?:api|x-api) key|oauth token|unauthori[sz]ed/i;
const BILLING = /billing|credit balance|payment/i;

/**
 * Turn any error from a provider into a ProviderError: CLI error text, API errors (with a
 * `status`), or plain errors. `resetsAt` comes from the CLI's rate-limit events when known.
 */
export function classifyError(err: unknown, resetsAt: string | null = null): ProviderError {
  if (err instanceof ProviderError) return err;
  const text = err instanceof Error ? err.message : String(err);
  const status = typeof err === 'object' && err && 'status' in err ? Number(err.status) : undefined;
  const detail = text.trim();

  if (BILLING.test(text) && !USAGE_LIMIT.test(text)) {
    return new ProviderError('billing', `Claude billing problem: ${detail}`);
  }
  if (status === 429 || USAGE_LIMIT.test(text)) {
    return new ProviderError('usage_limit', `Claude usage limit reached${detail ? ` (${detail})` : ''}.`, resetsAt);
  }
  if (status === 401 || AUTH.test(text)) {
    return new ProviderError(
      'auth',
      'Claude is not signed in. Run `claude` once in a terminal and log in (or check the API key), then retry.',
    );
  }
  return new ProviderError('other', detail || 'The model request failed');
}

/** The CLI reports reset times as Unix seconds (or milliseconds, or an ISO string). */
export function toIsoTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
