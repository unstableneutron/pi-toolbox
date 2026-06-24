import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai/compat';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

export function normalizeModelRef(value: string): string {
  return value.trim().toLowerCase();
}

export function modelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function sameModelName(model: Model<Api>, value: string): boolean {
  const normalized = normalizeModelRef(value);
  return (
    normalizeModelRef(model.id) === normalized ||
    normalizeModelRef(model.name ?? '') === normalized ||
    normalizeModelRef(modelRef(model)) === normalized
  );
}

function rankModelMatch(model: Model<Api>, query: string): number {
  const normalizedQuery = normalizeModelRef(query);
  const id = normalizeModelRef(model.id);
  const name = normalizeModelRef(model.name ?? '');
  const ref = normalizeModelRef(modelRef(model));

  if (id === normalizedQuery || name === normalizedQuery || ref === normalizedQuery) return 1000;
  if (id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) return 800;
  if (ref.includes(normalizedQuery)) return 600;
  if (id.includes(normalizedQuery) || name.includes(normalizedQuery)) return 500;
  return 0;
}

function pickBestModel(
  models: Model<Api>[],
  query: string,
): Model<Api> | { ambiguous: Model<Api>[] } | null {
  const ranked = models
    .map((model) => ({ model, score: rankModelMatch(model, query) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.length - b.model.id.length);

  if (ranked.length === 0) return null;

  const bestScore = ranked[0]!.score;
  const tied = ranked.filter((match) => match.score === bestScore).map((match) => match.model);
  return tied.length === 1 ? tied[0]! : { ambiguous: tied };
}

export function resolveEditorShortcutModel(
  rawQuery: string,
  models: Model<Api>[],
  currentModel?: Model<Api>,
): Model<Api> | { error: string } {
  const query = rawQuery.trim();
  if (!query) return { error: 'Usage: /model <model-or-provider/model>' };

  const slashIndex = query.indexOf('/');
  if (slashIndex !== -1) {
    const provider = query.slice(0, slashIndex).trim();
    const modelQuery = query.slice(slashIndex + 1).trim();
    const providerModels = models.filter(
      (model) => normalizeModelRef(model.provider) === normalizeModelRef(provider),
    );
    const exact = providerModels.find((model) => sameModelName(model, modelQuery));
    if (exact) return exact;

    const best = pickBestModel(providerModels, modelQuery);
    if (!best) return { error: `No model matches ${query}` };
    if ('ambiguous' in best) return { error: formatAmbiguousModels(query, best.ambiguous) };
    return best;
  }

  const exact = models.filter((model) => sameModelName(model, query));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return { error: formatAmbiguousModels(query, exact) };

  const providerModels = models.filter(
    (model) => normalizeModelRef(model.provider) === normalizeModelRef(query),
  );
  if (providerModels.length === 1) return providerModels[0]!;
  if (providerModels.length > 1 && currentModel) {
    const matchingCurrent = providerModels.find(
      (model) =>
        sameModelName(model, currentModel.id) ||
        (currentModel.name && sameModelName(model, currentModel.name)),
    );
    if (matchingCurrent) return matchingCurrent;
  }
  if (providerModels.length > 1) return { error: formatAmbiguousModels(query, providerModels) };

  const best = pickBestModel(models, query);
  if (!best) return { error: `No model matches ${query}` };
  if ('ambiguous' in best) return { error: formatAmbiguousModels(query, best.ambiguous) };
  return best;
}

function formatAmbiguousModels(query: string, models: Model<Api>[]): string {
  const sample = models.slice(0, 5).map(modelRef).join(', ');
  const suffix = models.length > 5 ? `, +${models.length - 5} more` : '';
  return `Ambiguous model "${query}". Matches: ${sample}${suffix}`;
}

function versionParts(value: string): number[] {
  return [...value.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function compareVersionPartsDesc(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] ?? -1;
    const rightPart = right[index] ?? -1;
    if (leftPart !== rightPart) return rightPart - leftPart;
  }
  return 0;
}

function compareModelsNewestFirst(left: Model<Api>, right: Model<Api>): number {
  const byVersion = compareVersionPartsDesc(
    versionParts(`${left.id} ${left.name ?? ''} ${modelRef(left)}`),
    versionParts(`${right.id} ${right.name ?? ''} ${modelRef(right)}`),
  );
  if (byVersion !== 0) return byVersion;
  return modelRef(left).localeCompare(modelRef(right));
}

export function getModelCandidates(ctx: ExtensionContext): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  return [...(available as Model<Api>[])].sort(compareModelsNewestFirst);
}

export function createModelCompletionItems(models: Model<Api>[]): AutocompleteItem[] {
  const sortedModels = [...models].sort(compareModelsNewestFirst);
  const modelItems: AutocompleteItem[] = sortedModels.map((model) => ({
    value: modelRef(model),
    label: model.id,
    description: model.name ? `${model.provider} — ${model.name}` : model.provider,
  }));

  return uniqueAutocompleteItems(modelItems);
}

export function uniqueAutocompleteItems(items: AutocompleteItem[]): AutocompleteItem[] {
  const seen = new Set<string>();
  const unique: AutocompleteItem[] = [];

  for (const item of items) {
    const key = item.value;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

export async function applyModelDirective(
  value: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  const model = resolveEditorShortcutModel(
    value,
    getModelCandidates(ctx),
    ctx.model as Model<Api> | undefined,
  );
  if ('error' in model) {
    ctx.ui.notify(model.error, 'warning');
    return false;
  }

  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(`No API key for ${modelRef(model)}`, 'warning');
    return false;
  }
  ctx.ui.notify(`Model: ${modelRef(model)}`, 'info');
  return true;
}
