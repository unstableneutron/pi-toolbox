import { afterEach, describe, expect, test, vi } from 'vitest';

import { shortenDisplayPath } from './paths';

describe('shared path rendering', () => {
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

  test('shortens paths relative to cwd when that is shorter than ~', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(
      shortenDisplayPath('/Users/example/projects/demo/src/app.ts', '/Users/example/projects/demo'),
    ).toBe('src/app.ts');
  });

  test('uses ~ form when home-relative is shorter than cwd-relative', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/Users/example/app.ts', '/Users/example/projects/demo')).toBe(
      '~/app.ts',
    );
  });

  test('falls back to original path when neither cwd-relative nor ~ applies', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/opt/some/system/path', '/Users/example/projects/demo')).toBe(
      '/opt/some/system/path',
    );
  });

  test('returns "." when the path equals cwd', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/Users/example/projects/demo', '/Users/example/projects/demo')).toBe(
      '.',
    );
  });

  test('still works without a cwd argument (backwards compatibility)', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/Users/example/projects/demo')).toBe('~/projects/demo');
  });

  test('ignores cwd when the path is not under it', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(shortenDisplayPath('/Users/example/a.ts', '/Users/example/projects/demo')).toBe(
      '~/a.ts',
    );
  });

  test('returns empty string for empty input', () => {
    expect(shortenDisplayPath(undefined)).toBe('');
    expect(shortenDisplayPath('')).toBe('');
  });
});
