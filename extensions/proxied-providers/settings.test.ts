import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  InvalidProxiedProvidersSettingsError,
  findProxiedProviderRewrite,
  isProviderProxied,
  loadProxiedProviderRewrites,
  loadProxiedProviders,
  mergeProxiedProviderRewrites,
  mergeProxiedProviders,
  normalizeModelAliasSourceRefs,
} from './settings';

describe('mergeProxiedProviders', () => {
  test('project settings override global settings per provider', () => {
    expect(
      mergeProxiedProviders(
        { 'amazon-bedrock': true, 'google-vertex': false },
        { 'google-vertex': true, 'openai-codex': true },
      ),
    ).toEqual({
      'amazon-bedrock': true,
      'google-vertex': true,
      'openai-codex': true,
    });
  });
});

describe('mergeProxiedProviderRewrites', () => {
  test('project settings override global rewrites per source pattern', () => {
    expect(
      mergeProxiedProviderRewrites(
        {
          'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
          'anthropic/claude-opus-4-6': {
            kind: 'rewrite',
            targetProvider: 'devai',
            targetModel: 'global.anthropic.claude-opus-4-6-v1',
          },
        },
        {
          'anthropic/claude-opus-4-6': {
            kind: 'rewrite',
            targetProvider: 'local',
            targetModel: 'opus',
          },
        },
      ),
    ).toEqual({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
      'anthropic/claude-opus-4-6': {
        kind: 'rewrite',
        targetProvider: 'local',
        targetModel: 'opus',
      },
    });
  });
});

describe('loadProxiedProviders', () => {
  test('loads and merges global + project settings.json files', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify(
        { proxiedProviders: { 'amazon-bedrock': true, 'google-vertex': false } },
        null,
        2,
      ),
    );
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({ proxiedProviders: { 'google-vertex': true } }, null, 2),
    );

    expect(loadProxiedProviders(cwd, agentDir)).toEqual({
      'amazon-bedrock': true,
      'google-vertex': true,
    });
  });

  test('returns empty map when settings files are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-missing-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(loadProxiedProviders(cwd, agentDir)).toEqual({});
  });

  test('throws when proxiedProviders is not a boolean map', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-bad-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviders: { 'amazon-bedrock': 'yes' } }, null, 2),
    );

    expect(() => loadProxiedProviders(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws when proxiedProviders is not an object map', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-shape-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviders: ['openai'] }, null, 2),
    );

    expect(() => loadProxiedProviders(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws InvalidProxiedProvidersSettingsError for malformed JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-json-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(agentDir, 'settings.json'), '{ invalid json');

    expect(() => loadProxiedProviders(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
    expect(() => loadProxiedProviders(root, agentDir)).toThrow(
      `${join(agentDir, 'settings.json')}: invalid JSON`,
    );
  });

  test('throws when settings file JSON is not an object', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-providers-top-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify('not-an-object'));

    expect(() => loadProxiedProviders(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });
});

describe('loadProxiedProviderRewrites', () => {
  test('loads provider-wide and specific rewrites from global + project settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify(
        {
          proxiedProviderRewrites: {
            'anthropic/*': 'devai',
            'anthropic/claude-opus-4-6': 'devai/global.anthropic.claude-opus-4-6-v1',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify(
        {
          proxiedProviderRewrites: {
            'anthropic/claude-opus-4-6': 'local-opus',
          },
        },
        null,
        2,
      ),
    );

    expect(loadProxiedProviderRewrites(cwd, agentDir)).toEqual({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
      'anthropic/claude-opus-4-6': {
        kind: 'rewrite',
        targetProvider: 'anthropic',
        targetModel: 'local-opus',
      },
    });
  });

  test('accepts cross-provider */model rewrites with a full target', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-cross-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify(
        {
          proxiedProviderRewrites: {
            '*/gpt-5.4-pro': 'facade/gpt-5.4-pro',
          },
        },
        null,
        2,
      ),
    );

    expect(loadProxiedProviderRewrites(root, agentDir)).toEqual({
      '*/gpt-5.4-pro': {
        kind: 'rewrite',
        targetProvider: 'facade',
        targetModel: 'gpt-5.4-pro',
      },
    });
  });

  test('accepts null as an exclusion target', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-null-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify(
        {
          proxiedProviderRewrites: {
            'anthropic/*': 'devai',
            'anthropic/claude-experimental': null,
          },
        },
        null,
        2,
      ),
    );

    expect(loadProxiedProviderRewrites(root, agentDir)).toEqual({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
      'anthropic/claude-experimental': { kind: 'exclude' },
    });
  });

  test('returns empty map when rewrites settings are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-missing-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(loadProxiedProviderRewrites(cwd, agentDir)).toEqual({});
  });

  test('throws when a key has no slash', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-bare-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify(
        {
          proxiedProviderRewrites: { 'gpt-5.4-pro': 'facade/gpt-5.4-pro' },
        },
        null,
        2,
      ),
    );

    expect(() => loadProxiedProviderRewrites(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws when key is */* (too broad)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-star-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviderRewrites: { '*/*': 'devai' } }, null, 2),
    );

    expect(() => loadProxiedProviderRewrites(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws when a value is an empty string', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-empty-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviderRewrites: { 'anthropic/*': '' } }, null, 2),
    );

    expect(() => loadProxiedProviderRewrites(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws when */model has a no-slash value (provider ambiguous)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-ambig-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviderRewrites: { '*/gpt-5.4-pro': 'facade' } }, null, 2),
    );

    expect(() => loadProxiedProviderRewrites(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });

  test('throws when rewrites map is not an object', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-proxied-provider-rewrites-shape-'));
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ proxiedProviderRewrites: ['bad'] }, null, 2),
    );

    expect(() => loadProxiedProviderRewrites(root, agentDir)).toThrow(
      InvalidProxiedProvidersSettingsError,
    );
  });
});

describe('normalizeModelAliasSourceRefs', () => {
  test('returns empty array for blank input', () => {
    expect(normalizeModelAliasSourceRefs('   ')).toEqual([]);
  });

  test('preserves bare shorthand ids', () => {
    expect(normalizeModelAliasSourceRefs('claude-haiku-4-5')).toEqual(['claude-haiku-4-5']);
  });

  test('strips bare date suffixes', () => {
    expect(normalizeModelAliasSourceRefs('claude-haiku-4-5-20251001')).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
    ]);
  });

  test('orders dated version suffix normalization from most to least specific', () => {
    expect(
      normalizeModelAliasSourceRefs('global.anthropic.claude-haiku-4-5-20251001-v1:0'),
    ).toEqual([
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'claude-haiku-4-5-20251001-v1:0',
      'global.anthropic.claude-haiku-4-5-20251001',
      'global.anthropic.claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
    ]);
  });

  test('strips plain version suffixes without dates', () => {
    expect(normalizeModelAliasSourceRefs('model-v2:0')).toEqual(['model-v2:0', 'model']);
  });

  test('strips -preview (with optional numeric suffix)', () => {
    expect(normalizeModelAliasSourceRefs('gemini-3.1-pro-preview')).toContain('gemini-3.1-pro');
    expect(normalizeModelAliasSourceRefs('gemini-3.1-pro-preview-0514')).toContain(
      'gemini-3.1-pro',
    );
  });

  test('strips -exp and -experimental', () => {
    expect(normalizeModelAliasSourceRefs('gemini-3.1-pro-exp')).toContain('gemini-3.1-pro');
    expect(normalizeModelAliasSourceRefs('gemini-3.1-pro-experimental')).toContain(
      'gemini-3.1-pro',
    );
  });

  test('strips -beta and -rc suffixes', () => {
    expect(normalizeModelAliasSourceRefs('claude-opus-4-7-beta')).toContain('claude-opus-4-7');
    expect(normalizeModelAliasSourceRefs('claude-opus-4-7-rc')).toContain('claude-opus-4-7');
    expect(normalizeModelAliasSourceRefs('claude-opus-4-7-rc2')).toContain('claude-opus-4-7');
  });
});

describe('findProxiedProviderRewrite', () => {
  test('tier 1: exact provider/id wins over bare and provider-wide', () => {
    const rewrites = {
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' } as const,
      '*/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'facade',
        targetModel: 'claude-haiku-4-5',
      } as const,
      'anthropic/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'devai',
        targetModel: 'global.anthropic.claude-haiku-4-5',
      } as const,
    };

    const hit = findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-haiku-4-5');
    expect(hit?.sourceRef).toBe('anthropic/claude-haiku-4-5');
    expect(hit?.specificity).toBe(1);
  });

  test('tier 3: normalized provider/id candidate via date strip', () => {
    const rewrites = {
      'anthropic/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'devai',
        targetModel: 'global.anthropic.claude-haiku-4-5',
      } as const,
    };

    const hit = findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-haiku-4-5-20251001-v1:0');
    expect(hit?.sourceRef).toBe('anthropic/claude-haiku-4-5');
    expect(hit?.specificity).toBe(3);
  });

  test('tier 4: cross-provider */id wins over provider-wide', () => {
    const rewrites = {
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' } as const,
      '*/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'facade',
        targetModel: 'claude-haiku-4-5',
      } as const,
    };

    const hit = findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-haiku-4-5');
    expect(hit?.sourceRef).toBe('*/claude-haiku-4-5');
    expect(hit?.specificity).toBe(4);
  });

  test('tier 7: provider/* fallback when no specific match exists', () => {
    const rewrites = {
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' } as const,
    };

    const hit = findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-sonnet-4-6');
    expect(hit?.sourceRef).toBe('anthropic/*');
    expect(hit?.specificity).toBe(7);
  });

  test('exclusion: null at exact-id tier blocks provider-wide fallback', () => {
    const rewrites = {
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' } as const,
      'anthropic/claude-experimental': { kind: 'exclude' } as const,
    };

    const hit = findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-experimental');
    expect(hit?.target.kind).toBe('exclude');
    expect(hit?.sourceRef).toBe('anthropic/claude-experimental');
  });

  test('matches bare */id when only a name differs from id', () => {
    const rewrites = {
      '*/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'facade',
        targetModel: 'target',
      } as const,
    };

    const hit = findProxiedProviderRewrite(
      rewrites,
      'amazon-bedrock',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'claude-haiku-4-5',
    );
    expect(hit?.sourceRef).toBe('*/claude-haiku-4-5');
  });

  test('returns undefined when nothing matches', () => {
    const rewrites = {
      'anthropic/claude-haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'devai',
        targetModel: 'target',
      } as const,
    };

    expect(findProxiedProviderRewrite(rewrites, 'openai', 'gpt-5.4-pro')).toBeUndefined();
  });

  test('lookup is case-insensitive for provider and id', () => {
    const rewrites = {
      'Anthropic/Claude-Haiku-4-5': {
        kind: 'rewrite',
        targetProvider: 'devai',
        targetModel: 'target',
      } as const,
    };

    expect(findProxiedProviderRewrite(rewrites, 'anthropic', 'claude-haiku-4-5')).toBeDefined();
  });
});

describe('isProviderProxied', () => {
  test('returns false when provider is missing', () => {
    expect(isProviderProxied('openai', { 'amazon-bedrock': true })).toBe(false);
  });
});
