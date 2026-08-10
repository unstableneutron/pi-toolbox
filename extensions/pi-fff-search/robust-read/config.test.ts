import { describe, expect, test } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG, loadRobustReadConfig } from './config';

describe('robust read configuration', () => {
  test('loads supported environment settings and lets valid API overrides win', () => {
    const config = loadRobustReadConfig(
      { maxLines: 25, rejectStaleWrites: true },
      {
        PI_ROBUST_READ_MAX_LINES: '50',
        PI_ROBUST_READ_MAX_BYTES: '4096',
        PI_ROBUST_READ_DEDUP: 'off',
      },
    );
    expect(config).toMatchObject({
      maxLines: 25,
      maxResponseBytes: 4096,
      deduplicateReads: false,
      rejectStaleWrites: true,
    });
  });

  test('rejects unsafe integer overrides and malformed environment values', () => {
    const config = loadRobustReadConfig(
      { maxResponseBytes: 0, streamChunkBytes: -1 },
      { PI_ROBUST_READ_MAX_LINES: 'not-a-number' },
    );
    expect(config.maxLines).toBe(DEFAULT_ROBUST_READ_CONFIG.maxLines);
    expect(config.maxResponseBytes).toBe(DEFAULT_ROBUST_READ_CONFIG.maxResponseBytes);
    expect(config.streamChunkBytes).toBe(DEFAULT_ROBUST_READ_CONFIG.streamChunkBytes);
  });
});
