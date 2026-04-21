import type { PublicToolName, PublicToolRequest } from 'fff-router';
import { clampMatchText } from './match-heuristics';

type RenderDetails = {
  toolName: PublicToolName;
  resolvedWithin: string;
  publicRequest: PublicToolRequest;
};

type RenderInput = {
  contentText: string;
  details?: RenderDetails;
  cwd?: string;
  width?: number;
};

type RenderContext = {
  cwd?: string;
};

type FileMatch = {
  path: string;
  count: number;
  previews: string[];
};

type PayloadParts = {
  basePath: string | null;
  bodyLines: string[];
};

const PLACEHOLDER_PATH_VALUES = new Set(['undefined', 'null']);

function titleForTool(toolName: PublicToolName): string {
  switch (toolName) {
    case 'fff_find_files':
      return 'FFF Find Files:';
    case 'fff_search_terms':
      return 'FFF Search Terms:';
    case 'fff_grep':
      return 'FFF Grep:';
  }
}

function splitPayload(text: string): PayloadParts {
  const lines = text.split('\n');
  const header = lines[0]?.startsWith('base_path: ') ? lines[0].slice('base_path: '.length) : null;
  if (!header || lines[1] !== '') {
    return { basePath: null, bodyLines: [] };
  }

  const bodyLines = lines.slice(2).filter((line) => line.length > 0);
  return { basePath: header, bodyLines };
}

function fallbackPreview(text: string): string {
  return text.split('\n').filter(Boolean).slice(0, 12).join('\n');
}

function findFilePaths(bodyLines: string[]): string[] {
  return bodyLines.filter((line) => line !== '(no files found)');
}

function groupMatchLines(bodyLines: string[]): FileMatch[] | null {
  const grouped = new Map<string, FileMatch>();
  for (const line of bodyLines) {
    if (line === '(no matches)') continue;

    const match = line.match(/^(.+?):(\d+):(?:\s)?(.*)$/);
    if (!match) return null;

    const [, path, lineNumber, text] = match;
    const entry = grouped.get(path) ?? { path, count: 0, previews: [] };
    entry.count += 1;
    if (entry.previews.length < 4) {
      entry.previews.push(`${lineNumber}: ${clampMatchText(text, path)}`);
    }
    grouped.set(path, entry);
  }

  return [...grouped.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function relativeCandidate(pathValue: string, anchor?: string): string | null {
  if (!anchor) {
    return null;
  }

  const normalizedPath = normalizeSlashes(pathValue).replace(/\/$/, '');
  const normalizedAnchor = normalizeSlashes(anchor).replace(/\/$/, '');
  if (!normalizedPath || !normalizedAnchor) {
    return null;
  }

  if (normalizedPath === normalizedAnchor) {
    return '.';
  }

  if (!normalizedPath.startsWith(`${normalizedAnchor}/`)) {
    return null;
  }

  return normalizedPath.slice(normalizedAnchor.length + 1);
}

function homeRelativeCandidate(pathValue: string): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return null;
  }

  const normalizedPath = normalizeSlashes(pathValue).replace(/\/$/, '');
  const normalizedHome = normalizeSlashes(home).replace(/\/$/, '');
  if (normalizedPath === normalizedHome) {
    return '~';
  }

  if (!normalizedPath.startsWith(`${normalizedHome}/`)) {
    return null;
  }

  return `~/${normalizedPath.slice(normalizedHome.length + 1)}`;
}

export function shortenDisplayPath(pathValue: string, cwd?: string): string {
  const candidates = [
    relativeCandidate(pathValue, cwd),
    homeRelativeCandidate(pathValue),
    pathValue,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .filter((value) => value !== '.');

  return candidates.sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )[0]!;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstPathString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDER_PATH_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }

  return trimmed;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function withinPrefixFromBasePath(basePath: string, resolvedWithin?: string): string | null {
  const relativeWithin = relativeCandidate(resolvedWithin ?? '', basePath);
  if (!relativeWithin || relativeWithin === '.') {
    return null;
  }
  return relativeWithin;
}

function shortenResultPath(
  pathValue: string,
  basePath: string,
  resolvedWithin?: string,
  cwd?: string,
): string {
  const relativeToWithin = relativeCandidate(pathValue, resolvedWithin);
  if (relativeToWithin && relativeToWithin !== '.') {
    return relativeToWithin;
  }

  const withinPrefix = withinPrefixFromBasePath(basePath, resolvedWithin);
  if (withinPrefix) {
    if (pathValue === withinPrefix) {
      return withinPrefix.split('/').pop() ?? pathValue;
    }
    if (pathValue.startsWith(`${withinPrefix}/`)) {
      return pathValue.slice(withinPrefix.length + 1);
    }
  }

  if (pathValue.startsWith('/')) {
    return shortenDisplayPath(pathValue, cwd);
  }

  return pathValue;
}

function collapseRedundantJavaPackage(pathValue: string): string | null {
  const normalizedPath = normalizeSlashes(pathValue);
  const match = normalizedPath.match(
    /^(projects\/([^/]+)\/src\/(?:main|test))\/java\/com\/example\/\2\/(.+)$/,
  );
  if (!match) {
    return null;
  }

  const [, sourceRoot, _projectName, remainder] = match;
  return `${sourceRoot}/.../${remainder}`;
}

function collapseMiddlePath(pathValue: string, maxWidth: number): string {
  if (maxWidth <= 0 || pathValue.length <= maxWidth) {
    return pathValue;
  }

  const exampleCollapsedPath = collapseRedundantJavaPackage(pathValue);
  const effectivePath =
    exampleCollapsedPath && exampleCollapsedPath.length < pathValue.length
      ? exampleCollapsedPath
      : pathValue;
  if (effectivePath.length <= maxWidth) {
    return effectivePath;
  }

  const parts = effectivePath.split('/').filter(Boolean);
  if (parts.length <= 2) {
    if (maxWidth <= 4) {
      return effectivePath.slice(0, Math.max(1, maxWidth));
    }
    return `${effectivePath.slice(0, Math.max(1, maxWidth - 4)).trimEnd()} ...`;
  }

  const head = parts.shift()!;
  const keptTail = [parts.pop()!];

  while (parts.length > 0) {
    const next = parts[parts.length - 1]!;
    const candidate = `${head}/.../${next}/${keptTail.join('/')}`;
    if (candidate.length > maxWidth) {
      break;
    }
    keptTail.unshift(parts.pop()!);
  }

  const collapsed = `${head}/.../${keptTail.join('/')}`;
  if (collapsed.length <= maxWidth) {
    return collapsed;
  }

  const leaf = keptTail.join('/');
  if (`.../${leaf}`.length <= maxWidth) {
    return `.../${leaf}`;
  }

  if (maxWidth <= 4) {
    return leaf.slice(0, Math.max(1, maxWidth));
  }

  return `${leaf.slice(0, Math.max(1, maxWidth - 4)).trimEnd()} ...`;
}

function formatCompactFileRow(pathValue: string, count: number, width?: number): string[] {
  if (!width || width <= 0) {
    return [`  · ${pathValue} — ${count}`];
  }

  const countSuffix = `— ${count}`;
  const inlineBudget = Math.max(24, width - '  · '.length - countSuffix.length - 1);
  const inlinePath = collapseMiddlePath(pathValue, inlineBudget);
  const singleLine = `  · ${inlinePath} ${countSuffix}`;

  if (singleLine.length <= width) {
    return [singleLine];
  }

  const hangingBudget = Math.max(24, width - '  · '.length);
  const hangingPath = collapseMiddlePath(pathValue, hangingBudget);
  return [`  · ${hangingPath}`, `    ${countSuffix}`];
}

function formatFileOnlyRow(pathValue: string, width?: number): string {
  if (!width || width <= 0) {
    return `  · ${pathValue}`;
  }

  const pathBudget = Math.max(24, width - '  · '.length);
  return `  · ${collapseMiddlePath(pathValue, pathBudget)}`;
}

function summarizeMatchFiles(
  files: FileMatch[],
  args: { basePath: string; details?: RenderDetails; cwd?: string; width?: number; limit: number },
): string[] {
  const totalMatches = files.reduce((sum, file) => sum + file.count, 0);
  const lines = [`${files.length} files · ${totalMatches} matches`];

  for (const file of files.slice(0, args.limit)) {
    const displayPath = shortenResultPath(
      file.path,
      args.basePath,
      args.details?.resolvedWithin,
      args.cwd,
    );
    lines.push(...formatCompactFileRow(displayPath, file.count, args.width));
  }

  if (files.length > args.limit) {
    lines.push(`    … ${files.length - args.limit} more files`);
  }

  return lines;
}

export function formatToolCallText(
  toolName: PublicToolName,
  args: Record<string, unknown>,
  context: RenderContext = {},
  width?: number,
): string {
  const title = titleForTool(toolName);
  const primary =
    toolName === 'fff_find_files'
      ? firstString(args.query)
      : toolName === 'fff_search_terms'
        ? stringList(args.terms).join(', ')
        : (() => {
            const patterns = stringList(args.patterns);
            if (patterns.length > 0) {
              return patterns.join(' | ');
            }
            return firstString(args.pattern);
          })();

  const lines = [primary ? `${title}  ${primary}` : title];
  const metadata: string[] = [];
  const within = firstPathString(args.within);
  if (within) {
    metadata.push(`within: ${shortenDisplayPath(within, context.cwd)}`);
  }

  const glob = firstString(args.glob);
  if (glob) {
    metadata.push(`glob: ${glob}`);
  }

  if (toolName === 'fff_grep') {
    // Mode flags follow the "only surface when non-default" convention (same
    // as `case-sensitive` and `limit`). Regex is the common case for LLM
    // search, so we only annotate the call when the caller opted into
    // literal matching.
    if (args.literal === true) {
      metadata.push('literal');
    }
    if (args.case_sensitive === true) {
      metadata.push('case-sensitive');
    }
  }

  const extensions = stringList(args.extensions);
  if (extensions.length > 0) {
    metadata.push(`ext: ${extensions.join(', ')}`);
  }

  const excluded = stringList(args.exclude_paths);
  if (excluded.length > 0) {
    metadata.push(`exclude: ${excluded.join(', ')}`);
  }

  if (typeof args.limit === 'number' && args.limit !== 20) {
    metadata.push(`limit: ${args.limit}`);
  }

  if (metadata.length > 0) {
    if (!width || width <= 0) {
      lines.push(`  ${metadata.join('  ')}`);
    } else {
      let currentLine = '  ';

      for (const entry of metadata) {
        const candidate = currentLine === '  ' ? `  ${entry}` : `${currentLine}  ${entry}`;

        if (currentLine !== '  ' && candidate.length > width) {
          lines.push(currentLine);
          currentLine = `  ${entry}`;
          continue;
        }

        currentLine = candidate;
      }

      if (currentLine !== '  ') {
        lines.push(currentLine);
      }
    }
  }

  return lines.join('\n');
}

export function formatCollapsedResultText(toolName: PublicToolName, input: RenderInput): string {
  const parsed = splitPayload(input.contentText);
  if (!parsed.basePath) {
    return fallbackPreview(input.contentText);
  }

  if (toolName === 'fff_find_files') {
    const paths = findFilePaths(parsed.bodyLines);
    if (paths.length === 0) {
      return '0 files';
    }

    const lines = [`${paths.length} files`];
    for (const path of paths.slice(0, 2)) {
      lines.push(
        formatFileOnlyRow(
          shortenResultPath(path, parsed.basePath, input.details?.resolvedWithin, input.cwd),
          input.width,
        ),
      );
    }
    if (paths.length > 2) {
      lines.push(`    … ${paths.length - 2} more`);
    }
    return lines.join('\n');
  }

  const grouped = groupMatchLines(parsed.bodyLines);
  if (!grouped) {
    return fallbackPreview(input.contentText);
  }
  if (grouped.length === 0) {
    return 'No matches';
  }

  return summarizeMatchFiles(grouped, {
    basePath: parsed.basePath,
    details: input.details,
    cwd: input.cwd,
    width: input.width,
    limit: 2,
  }).join('\n');
}

export function formatExpandedResultText(toolName: PublicToolName, input: RenderInput): string {
  const parsed = splitPayload(input.contentText);
  if (!parsed.basePath) {
    return fallbackPreview(input.contentText);
  }

  if (toolName === 'fff_find_files') {
    const paths = findFilePaths(parsed.bodyLines);
    if (paths.length === 0) {
      return '0 files';
    }

    const lines = [`${paths.length} files`];
    for (const path of paths.slice(0, 12)) {
      lines.push(
        formatFileOnlyRow(
          shortenResultPath(path, parsed.basePath, input.details?.resolvedWithin, input.cwd),
          input.width,
        ),
      );
    }
    if (paths.length > 12) {
      lines.push(`    … ${paths.length - 12} more`);
    }
    return lines.join('\n');
  }

  const grouped = groupMatchLines(parsed.bodyLines);
  if (!grouped) {
    return fallbackPreview(input.contentText);
  }
  if (grouped.length === 0) {
    return 'No matches';
  }

  if (!input.width) {
    const totalMatches = grouped.reduce((sum, file) => sum + file.count, 0);
    const top = grouped[0]!;
    const lines = [`${grouped.length} files · ${totalMatches} matches`, '  Files'];

    for (const file of grouped.slice(0, 8)) {
      const displayPath = shortenResultPath(
        file.path,
        parsed.basePath,
        input.details?.resolvedWithin,
        input.cwd,
      );
      lines.push(`  · ${displayPath} — ${file.count}`);
    }
    if (grouped.length > 8) {
      lines.push(`    … ${grouped.length - 8} more files`);
    }

    const topPath = shortenResultPath(
      top.path,
      parsed.basePath,
      input.details?.resolvedWithin,
      input.cwd,
    );
    lines.push('  Top file');
    lines.push(`  ${topPath} — ${top.count} matches`);
    for (const preview of top.previews) {
      lines.push(`    ${preview}`);
    }
    if (top.count > top.previews.length) {
      lines.push(`    … ${top.count - top.previews.length} more matches`);
    }

    return lines.join('\n');
  }

  const totalMatches = grouped.reduce((sum, file) => sum + file.count, 0);
  const top = grouped[0]!;
  const lines = [`${grouped.length} files · ${totalMatches} matches`, '  Files'];

  for (const file of grouped.slice(0, 8)) {
    const displayPath = shortenResultPath(
      file.path,
      parsed.basePath,
      input.details?.resolvedWithin,
      input.cwd,
    );
    lines.push(...formatCompactFileRow(displayPath, file.count, input.width));
  }
  if (grouped.length > 8) {
    lines.push(`    … ${grouped.length - 8} more files`);
  }

  const topPath = shortenResultPath(
    top.path,
    parsed.basePath,
    input.details?.resolvedWithin,
    input.cwd,
  );
  lines.push('  Top file');
  lines.push(
    ...formatCompactFileRow(topPath, top.count, input.width).map((line) => `  ${line.slice(2)}`),
  );
  for (const preview of top.previews) {
    lines.push(`    ${preview}`);
  }
  if (top.count > top.previews.length) {
    lines.push(`    … ${top.count - top.previews.length} more matches`);
  }

  return lines.join('\n');
}
