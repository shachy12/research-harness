import { describe, expect, it } from 'vitest';
import { mergePaths, pathFromShellOutput, useLoginShellPath } from './shell-path.ts';

describe('login shell PATH', () => {
  it('reads PATH between the markers, ignoring what startup files print', () => {
    expect(pathFromShellOutput('Welcome!\n__HARNESS_PATH__/a:/b__HARNESS_PATH__')).toBe('/a:/b');
    expect(pathFromShellOutput('no markers')).toBeNull();
  });

  // Only used on macOS and Linux; on Windows path.delimiter is ';', not the ':' written here.
  it.runIf(process.platform !== 'win32')("puts the shell's entries first without duplicates", () => {
    expect(mergePaths('/home/me/.local/bin:/usr/bin', '/usr/bin:/bin:')).toBe('/home/me/.local/bin:/usr/bin:/bin');
  });

  it.runIf(process.platform !== 'win32')('takes the PATH a real shell reports', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: '/nonexistent' };
    useLoginShellPath(env);
    expect(env.PATH!.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin']));
  });

  it('leaves PATH alone when the shell fails', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/does/not/exist', PATH: '/usr/bin' };
    useLoginShellPath(env, 'linux');
    expect(env.PATH).toBe('/usr/bin');
  });
});
