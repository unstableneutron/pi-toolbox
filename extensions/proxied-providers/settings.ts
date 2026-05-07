import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type ProxiedProvidersMap = Record<string, boolean>;

/**
 * A rewrite target. `null` means "explicitly do not rewrite" — useful for
 * punching holes in a broader wildcard (e.g. rewrite all of `anthropic/*`
 * except for one specific model).
 */
export type ProxiedProviderRewriteTarget =
  | { kind: 'rewrite'; targetProvider: string; targetModel?: string }
  | { kind: 'exclude' };

/**
 * Map keyed by source patterns. Keys always contain exactly one `/`, where
 * `*` on either side marks a wildcard:
 *
 *   provider/model  — specific model from a specific provider
 *   provider/*      — any model from this provider (provider-wide)
 *   *\/model         — any provider's model with this id/name (cross-provider)
 *   *\/*             — rejected (meaningless / too broad)
 *
 * Values:
 *   "provider"              target provider only; keep source model id/name
 *                           (only valid when key has /* on the right)
 *   "provider/model"        explicit target provider + model
 *   "model" (no slash)      same provider as key; target id override
 *                           (only valid when key is fully specific)
 *   null                    exclusion — stop and do not rewrite
 */
export type ProxiedProviderRewritesMap = Record<string, ProxiedProviderRewriteTarget>;

type ResolvedRewriteHit = {
  sourceRef: string;
  /** Precedence tier — lower wins. Used for diagnostic / exclusion logic. */
  specificity: number;
  target: ProxiedProviderRewriteTarget;
};

type SettingsShape = {
  proxiedProviders?: Record<string, unknown>;
  proxiedProviderRewrites?: Record<string, unknown>;
};

export class InvalidProxiedProvidersSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProxiedProvidersSettingsError';
  }
}

function readSettingsFile(path: string): SettingsShape {
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new InvalidProxiedProvidersSettingsError(`${path}: invalid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidProxiedProvidersSettingsError(
      `${path}: settings file must contain a JSON object`,
    );
  }

  return parsed as SettingsShape;
}

function parseProxiedProviders(value: unknown, source: string): ProxiedProvidersMap {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviders must be an object mapping provider ids to booleans`,
    );
  }

  const result: ProxiedProvidersMap = {};
  for (const [provider, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') {
      throw new InvalidProxiedProvidersSettingsError(
        `${source}: proxiedProviders.${provider} must be a boolean`,
      );
    }
    result[provider] = enabled;
  }
  return result;
}

function splitRef(ref: string): { head: string; tail: string } | undefined {
  const slashIndex = ref.indexOf('/');
  if (slashIndex === -1) return undefined;
  const head = ref.slice(0, slashIndex).trim();
  const tail = ref.slice(slashIndex + 1).trim();
  if (!head || !tail) return undefined;
  return { head, tail };
}

/**
 * Parse a rewrite key. Keys must contain exactly one `/`. `*` on either
 * side is a wildcard. Returns the normalized key parts.
 */
function parseRewriteKey(
  key: string,
  source: string,
): { provider: string; model: string; providerWildcard: boolean; modelWildcard: boolean } {
  const parts = splitRef(key);
  if (!parts) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites key ${JSON.stringify(key)} must be "provider/model" or use "provider/*" / "*/model" wildcards`,
    );
  }

  const providerWildcard = parts.head === '*';
  const modelWildcard = parts.tail === '*';

  if (providerWildcard && modelWildcard) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites key "*/*" is too broad; write explicit rules instead`,
    );
  }

  if (parts.head.includes('*') && !providerWildcard) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites key ${JSON.stringify(key)} — partial wildcards in provider segment are not supported`,
    );
  }
  if (parts.tail.includes('*') && !modelWildcard) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites key ${JSON.stringify(key)} — partial wildcards in model segment are not supported`,
    );
  }

  return {
    provider: parts.head,
    model: parts.tail,
    providerWildcard,
    modelWildcard,
  };
}

function parseRewriteValue(
  key: string,
  value: unknown,
  keyParts: ReturnType<typeof parseRewriteKey>,
  source: string,
): ProxiedProviderRewriteTarget {
  if (value === null) {
    return { kind: 'exclude' };
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites.${key} must be a non-empty string or null`,
    );
  }

  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf('/');

  if (slashIndex === -1) {
    // Value has no slash. Disambiguate based on key shape:
    //   provider/*  →  value is target provider (model kept from source)
    //   provider/x  →  value is target model id (same provider as key)
    //   */model     →  ambiguous (which provider?) → reject
    if (keyParts.modelWildcard) {
      return { kind: 'rewrite', targetProvider: trimmed };
    }
    if (keyParts.providerWildcard) {
      throw new InvalidProxiedProvidersSettingsError(
        `${source}: proxiedProviderRewrites.${key} — value must include a provider (e.g. "devai/${trimmed}") because the key has no explicit source provider`,
      );
    }
    return { kind: 'rewrite', targetProvider: keyParts.provider, targetModel: trimmed };
  }

  const targetProvider = trimmed.slice(0, slashIndex).trim();
  const targetModel = trimmed.slice(slashIndex + 1).trim();
  if (!targetProvider || !targetModel) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites.${key} — target ${JSON.stringify(trimmed)} must be "provider/model"`,
    );
  }
  return { kind: 'rewrite', targetProvider, targetModel };
}

function parseProxiedProviderRewrites(value: unknown, source: string): ProxiedProviderRewritesMap {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxiedProvidersSettingsError(
      `${source}: proxiedProviderRewrites must be an object mapping provider/model patterns to targets`,
    );
  }

  const result: ProxiedProviderRewritesMap = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const keyParts = parseRewriteKey(key, source);
    result[key] = parseRewriteValue(key, rawValue, keyParts, source);
  }
  return result;
}

function addSlashSuffixCandidates(candidates: Set<string>, value: string): void {
  let current = value.trim();
  while (current) {
    candidates.add(current);
    const slashIndex = current.indexOf('/');
    if (slashIndex === -1) break;
    current = current.slice(slashIndex + 1).trim();
  }
}

/**
 * Expand a model ref into normalized candidate forms for fuzzy matching.
 * Strips known "boring" suffixes (version, date, preview/exp/beta/rc) so
 * that a single rewrite rule can match many variants of the same model.
 */
export function normalizeModelAliasSourceRefs(model: string): string[] {
  const candidates = new Set<string>();
  const trimmed = model.trim();
  if (!trimmed) return [];

  addSlashSuffixCandidates(candidates, trimmed);

  const stripSuffixes = [
    // Version suffix with optional minor version, e.g. -v1, -v2:0
    /-v\d+(?::\d+)?$/i,
    // Date suffix with optional version, e.g. -20251001, -20251001-v1:0
    /-20\d{6}(?:-v\d+(?::\d+)?)?$/i,
    // Preview / experimental / beta / release-candidate suffixes
    /-preview(?:-\d+)?$/i,
    /-exp(?:erimental)?$/i,
    /-beta$/i,
    /-rc\d*$/i,
  ];

  // Snapshot before iterating: the loop body adds new entries to `candidates`
  // and we don't want those new entries re-processed.
  const initialCandidates = Array.from(candidates);
  for (const slashCandidate of initialCandidates) {
    const dottedTail = slashCandidate.includes('.')
      ? slashCandidate.slice(slashCandidate.lastIndexOf('.') + 1)
      : slashCandidate;
    candidates.add(dottedTail);
    // Apply suffix strips to both the full candidate and its dotted tail.
    // The full form matters for ids containing dots (e.g. gemini-3.1-pro-preview)
    // where the dotted tail alone (`pro-preview`) loses context.
    for (const base of [slashCandidate, dottedTail]) {
      for (const pattern of stripSuffixes) {
        candidates.add(base.replace(pattern, ''));
      }
    }
  }

  return [...candidates].filter(Boolean);
}

/**
 * Resolve the highest-specificity rewrite target for a source model.
 * Walks precedence tiers from most specific to least specific; the first
 * match wins. An explicit `null` exclusion at any tier blocks lower tiers.
 */
export function findProxiedProviderRewrite(
  rewrites: ProxiedProviderRewritesMap,
  provider: string,
  modelId: string,
  modelName?: string,
): ResolvedRewriteHit | undefined {
  const providerLower = provider.toLowerCase();
  const modelIdLower = modelId.toLowerCase();
  const modelNameLower = modelName?.toLowerCase();

  // Lowercase-map the rewrites keys for case-insensitive lookup.
  const lcKeys = new Map<string, string>();
  for (const key of Object.keys(rewrites)) {
    lcKeys.set(key.toLowerCase(), key);
  }

  const tryKey = (candidate: string, specificity: number): ResolvedRewriteHit | undefined => {
    const originalKey = lcKeys.get(candidate.toLowerCase());
    if (!originalKey) return undefined;
    const target = rewrites[originalKey];
    return { sourceRef: originalKey, specificity, target };
  };

  // Tier 1: exact provider/id
  const tier1 = tryKey(`${providerLower}/${modelIdLower}`, 1);
  if (tier1) return tier1;

  // Tier 2: exact provider/name
  if (modelNameLower && modelNameLower !== modelIdLower) {
    const tier2 = tryKey(`${providerLower}/${modelNameLower}`, 2);
    if (tier2) return tier2;
  }

  // Tier 3: normalized provider/id candidates
  for (const cand of normalizeModelAliasSourceRefs(modelId)) {
    if (cand.toLowerCase() === modelIdLower) continue;
    const hit = tryKey(`${providerLower}/${cand}`, 3);
    if (hit) return hit;
  }
  if (modelNameLower && modelNameLower !== modelIdLower) {
    for (const cand of normalizeModelAliasSourceRefs(modelName ?? '')) {
      if (cand.toLowerCase() === modelNameLower) continue;
      const hit = tryKey(`${providerLower}/${cand}`, 3);
      if (hit) return hit;
    }
  }

  // Tier 4: cross-provider exact id via */model
  const tier4id = tryKey(`*/${modelIdLower}`, 4);
  if (tier4id) return tier4id;

  // Tier 5: cross-provider exact name via */name
  if (modelNameLower && modelNameLower !== modelIdLower) {
    const tier5 = tryKey(`*/${modelNameLower}`, 5);
    if (tier5) return tier5;
  }

  // Tier 6: normalized cross-provider candidates via */x
  for (const cand of normalizeModelAliasSourceRefs(modelId)) {
    if (cand.toLowerCase() === modelIdLower) continue;
    const hit = tryKey(`*/${cand}`, 6);
    if (hit) return hit;
  }
  if (modelNameLower && modelNameLower !== modelIdLower) {
    for (const cand of normalizeModelAliasSourceRefs(modelName ?? '')) {
      if (cand.toLowerCase() === modelNameLower) continue;
      const hit = tryKey(`*/${cand}`, 6);
      if (hit) return hit;
    }
  }

  // Tier 7: provider-wide via provider/*
  const tier7 = tryKey(`${providerLower}/*`, 7);
  if (tier7) return tier7;

  return undefined;
}

export function mergeProxiedProviders(
  globalMap: ProxiedProvidersMap,
  projectMap: ProxiedProvidersMap,
): ProxiedProvidersMap {
  return { ...globalMap, ...projectMap };
}

export function mergeProxiedProviderRewrites(
  globalMap: ProxiedProviderRewritesMap,
  projectMap: ProxiedProviderRewritesMap,
): ProxiedProviderRewritesMap {
  return { ...globalMap, ...projectMap };
}

export function loadProxiedProviders(
  cwd: string,
  agentDir: string = getAgentDir(),
): ProxiedProvidersMap {
  const globalSettings = readSettingsFile(join(agentDir, 'settings.json'));
  const projectSettings = readSettingsFile(join(cwd, '.pi', 'settings.json'));
  return mergeProxiedProviders(
    parseProxiedProviders(globalSettings.proxiedProviders, join(agentDir, 'settings.json')),
    parseProxiedProviders(projectSettings.proxiedProviders, join(cwd, '.pi', 'settings.json')),
  );
}

export function loadProxiedProviderRewrites(
  cwd: string,
  agentDir: string = getAgentDir(),
): ProxiedProviderRewritesMap {
  const globalSettings = readSettingsFile(join(agentDir, 'settings.json'));
  const projectSettings = readSettingsFile(join(cwd, '.pi', 'settings.json'));
  return mergeProxiedProviderRewrites(
    parseProxiedProviderRewrites(
      globalSettings.proxiedProviderRewrites,
      join(agentDir, 'settings.json'),
    ),
    parseProxiedProviderRewrites(
      projectSettings.proxiedProviderRewrites,
      join(cwd, '.pi', 'settings.json'),
    ),
  );
}

export function isProviderProxied(
  provider: string,
  proxiedProviders: ProxiedProvidersMap,
): boolean {
  return proxiedProviders[provider] === true;
}
