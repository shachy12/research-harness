import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateChecker, isNewer } from './update-check.ts';

/** A registry that answers with `version` (or fails), recording the URLs asked for. */
function registry(answers: (string | Error)[]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const next = answers.shift() ?? new Error('no more answers');
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => ({ name: 'research-harness', version: next }) };
  };
  return { fetch, urls };
}

describe('isNewer', () => {
  it('compares versions by number, ignoring pre-releases as updates', () => {
    expect(isNewer('0.2.11', '0.2.10')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.10', '0.2.10')).toBe(false);
    expect(isNewer('0.2.9', '0.2.10')).toBe(false);
    expect(isNewer('0.3.0-beta.1', '0.2.10')).toBe(false);
    expect(isNewer('0.3.0', '0.3.0-beta.1')).toBe(true);
    expect(isNewer('nonsense', '0.2.10')).toBe(false);
  });
});

describe('UpdateChecker', () => {
  afterEach(() => vi.useRealTimers());

  it('asks npm for the latest version and says whether it is newer', async () => {
    const { fetch, urls } = registry(['0.2.10', '0.2.11']);
    const checker = new UpdateChecker('0.2.10', { fetch });
    expect(checker.info()).toEqual({ current: '0.2.10', latest: null, updateAvailable: false, checkedAt: null });
    await checker.check();
    expect(urls).toEqual(['https://registry.npmjs.org/research-harness/latest']);
    expect(checker.info()).toMatchObject({ latest: '0.2.10', updateAvailable: false });
    await checker.check();
    expect(checker.info()).toMatchObject({ latest: '0.2.11', updateAvailable: true, checkedAt: expect.any(String) });
  });

  it('keeps the last answer when a check fails', async () => {
    const { fetch } = registry(['0.2.11', new Error('offline')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const checker = new UpdateChecker('0.2.10', { fetch });
    await checker.check();
    expect(await checker.check()).toBeNull();
    expect(checker.info()).toMatchObject({ latest: '0.2.11', updateAvailable: true });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('checks at the start and then every interval', async () => {
    vi.useFakeTimers();
    const { fetch, urls } = registry(['0.2.10', '0.2.10', '0.2.12']);
    const checker = new UpdateChecker('0.2.10', { fetch, intervalMs: 30 * 60_000 });
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(urls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(checker.info()).toMatchObject({ latest: '0.2.12', updateAvailable: true });
    checker.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(urls).toHaveLength(3);
  });
});
