import { afterEach, describe, expect, test, vi } from 'vitest';

import { shortenDisplayPath } from './render-utils';

describe('multi-edit render utils', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('shortens paths relative to HOME when shorter', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/Users/example/projects/demo')).toBe('~/projects/demo');
    expect(shortenDisplayPath('/Users/example')).toBe('~');
  });

  test('shortens paths relative to USERPROFILE on windows-style paths', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\example');

    expect(shortenDisplayPath('C:\\Users\\example\\projects\\demo')).toBe('~\\projects\\demo');
    expect(shortenDisplayPath('C:\\Users\\example')).toBe('~');
  });

  test('shortens paths relative to TMPDIR when shorter', () => {
    vi.stubEnv('TMPDIR', '/var/folders/ab/cdef1234/T');

    expect(shortenDisplayPath('/var/folders/ab/cdef1234/T/demo/file.txt')).toBe(
      '$TMPDIR/demo/file.txt',
    );
    expect(shortenDisplayPath('/var/folders/ab/cdef1234/T')).toBe('$TMPDIR');
  });

  test('shortens paths relative to TEMP and TMP on windows-style paths', () => {
    vi.stubEnv('TEMP', 'C:\\TempRoot');
    vi.stubEnv('TMP', 'D:\\Scratch');

    expect(shortenDisplayPath('C:\\TempRoot\\demo\\file.txt')).toBe('$TEMP\\demo\\file.txt');
    expect(shortenDisplayPath('D:\\Scratch\\demo\\file.txt')).toBe('$TMP\\demo\\file.txt');
  });
});
