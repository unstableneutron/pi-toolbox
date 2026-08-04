import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyBtwConfigCommand,
  DEFAULT_BTW_CONFIG,
  normalizeBtwConfig,
  parseBtwInvocation,
  readBtwConfig,
  writeBtwConfig,
} from './config';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

describe('BTW configuration', () => {
  test('defaults to a Herdr popup with inline fallback', () => {
    expect(normalizeBtwConfig(undefined)).toEqual({
      defaultMode: 'popup',
      fallbackMode: 'inline',
    });
  });

  test('updates the default and fallback modes', () => {
    const popup = applyBtwConfigCommand(DEFAULT_BTW_CONFIG, 'mode overlay');
    expect(popup).toEqual({
      config: { defaultMode: 'overlay', fallbackMode: 'inline' },
      changed: true,
    });
    expect(applyBtwConfigCommand(popup.config, 'fallback pane').config).toEqual({
      defaultMode: 'overlay',
      fallbackMode: 'pane',
    });
  });

  test('persists private JSON configuration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-config-test-'));
    temporaryPaths.push(directory);
    const filePath = path.join(directory, 'agent', 'btw.json');
    const config = { defaultMode: 'pane', fallbackMode: 'inline' } as const;

    writeBtwConfig(config, filePath);

    expect(readBtwConfig(filePath)).toEqual(config);
    expect(fs.statSync(filePath).mode & 0o077).toBe(0);
  });

  test('rejects unsupported configuration values', () => {
    expect(() => applyBtwConfigCommand(DEFAULT_BTW_CONFIG, 'mode floating')).toThrow(
      'Usage: /btw config',
    );
  });

  test('keeps config questions available through the ask escape', () => {
    expect(parseBtwInvocation('config mode pane')).toEqual({
      kind: 'config',
      args: 'mode pane',
    });
    expect(parseBtwInvocation('ask config mode pane')).toEqual({
      kind: 'question',
      question: 'config mode pane',
    });
  });
});
