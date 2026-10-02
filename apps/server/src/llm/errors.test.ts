import { describe, expect, it } from 'vitest';
import { classifyError, toIsoTime } from './errors.ts';
import { cleanTitle } from './title.ts';

describe('classifyError', () => {
  it.each([
    ["You've hit your limit · resets 5pm (Europe/Berlin)", 'usage_limit'],
    ['Claude AI usage limit reached|1790000000', 'usage_limit'],
    ['Invalid API key · Please run /login', 'auth'],
    ['Your credit balance is too low to access the Anthropic API', 'billing'],
    ['socket hang up', 'other'],
  ])('%s → %s', (text, kind) => {
    expect(classifyError(new Error(text)).kind).toBe(kind);
  });

  it('uses the HTTP status of API errors', () => {
    expect(classifyError(Object.assign(new Error('Too many requests'), { status: 429 })).kind).toBe('usage_limit');
    expect(classifyError(Object.assign(new Error('Nope'), { status: 401 })).kind).toBe('auth');
  });

  it('keeps the reset time it is given', () => {
    expect(classifyError(new Error('usage limit reached'), '2026-10-02T15:00:00.000Z').resetsAt).toBe('2026-10-02T15:00:00.000Z');
  });
});

describe('toIsoTime', () => {
  it('reads Unix seconds, milliseconds and ISO strings', () => {
    expect(toIsoTime(1790000000)).toBe(new Date(1790000000 * 1000).toISOString());
    expect(toIsoTime(1790000000000)).toBe(new Date(1790000000000).toISOString());
    expect(toIsoTime('2026-10-02T15:00:00Z')).toBe('2026-10-02T15:00:00.000Z');
    expect(toIsoTime(undefined)).toBeNull();
  });
});

describe('cleanTitle', () => {
  it.each([
    ['"Linear-Storage RC-PIR Feasibility."', 'Linear-Storage RC-PIR Feasibility'],
    ['Title: **Cube-root PIR costs**', 'Cube-root PIR costs'],
    ['# Retrieval survey\nextra line', 'Retrieval survey'],
    ['   ', ''],
  ])('%s → %s', (raw, title) => {
    expect(cleanTitle(raw)).toBe(title);
  });
});
