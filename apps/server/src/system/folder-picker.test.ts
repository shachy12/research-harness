import { describe, expect, it } from 'vitest';
import { checkWindowsPicker } from './folder-picker.ts';

describe('folder picker', () => {
  // Compiles the dialog code and creates the dialog without showing it, so nothing pops up.
  it.runIf(process.platform === 'win32')('builds the Windows folder dialog', async () => {
    await expect(checkWindowsPicker()).resolves.toBeUndefined();
  }, 30_000);
});
