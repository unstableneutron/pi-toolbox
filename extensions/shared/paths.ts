import { visibleWidth } from '@earendil-works/pi-tui';

/**
 * Produce the shortest human-readable rendering of `inputPath`.
 *
 * Tried candidates, in order of generation (ultimately sorted by length):
 *   1. Path relative to `cwd` (no `../` prefix — only when the path
 *      is genuinely inside cwd). Equal paths collapse to `.`.
 *   2. Path with `$HOME` / `$USERPROFILE` replaced by `~`.
 *   3. Path with `$TMPDIR` / `$TEMP` / `$TMP` replaced by the env
 *      variable name (quiets the long `/var/folders/...` noise on
 *      macOS).
 *   4. The original absolute path.
 *
 * The shortest candidate wins (ties broken by lexical order for
 * deterministic rendering). Separator style (`/` vs `\\`) is preserved
 * as-is from the input — no implicit normalization — so Windows
 * callers still get `~\projects\demo` and POSIX callers still get
 * `~/projects/demo`.
 *
 * Terminal-width truncation stays a separate concern. Call sites
 * (e.g. `display/apply-patch-summary.ts`, `pi-fff-search/rendering`)
 * layer their own middle-ellipsis or truncate-to-width pass on top.
 *
 * Single source of truth shared by `multi-edit` and `pi-fff-search`
 * so edit, apply_patch, grep, and find render paths identically.
 */
export function shortenDisplayPath(inputPath: string | undefined, cwd?: string): string {
  if (!inputPath) {
    return '';
  }

  const candidates: string[] = [inputPath];

  const cwdCandidate = cwdRelativeCandidate(inputPath, cwd);
  if (cwdCandidate !== null) {
    candidates.push(cwdCandidate);
  }

  const prefixes = [
    { value: process.env.HOME, label: '~' },
    { value: process.env.USERPROFILE, label: '~' },
    { value: process.env.TMPDIR, label: '$TMPDIR' },
    { value: process.env.TEMP, label: '$TEMP' },
    { value: process.env.TMP, label: '$TMP' },
  ].filter(
    (entry): entry is { value: string; label: string } =>
      typeof entry.value === 'string' && entry.value.length > 0,
  );

  for (const prefix of prefixes) {
    const candidate =
      inputPath === prefix.value
        ? prefix.label
        : inputPath.startsWith(`${prefix.value}/`) || inputPath.startsWith(`${prefix.value}\\`)
          ? `${prefix.label}${inputPath.slice(prefix.value.length)}`
          : null;
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }

  return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

export function truncateDisplayPath(
  inputPath: string | undefined,
  maxWidth: number,
  cwd?: string,
): string {
  return truncatePathLikeToWidth(shortenDisplayPath(inputPath, cwd), maxWidth);
}

export function truncatePathLikeToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  const pathCollapsed = truncatePathSegmentsToWidth(text, maxWidth);
  return pathCollapsed ?? truncateMiddleToWidth(text, maxWidth);
}

export function truncateMiddleToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return '.'.repeat(maxWidth);

  const ellipsis = '...';
  const remainingWidth = maxWidth - visibleWidth(ellipsis);
  const suffixWidth = Math.max(1, Math.floor(remainingWidth / 2));
  const prefixWidth = Math.max(1, remainingWidth - suffixWidth);
  let prefix = takePrefixToWidth(text, prefixWidth);
  let suffix = takeSuffixToWidth(text, suffixWidth);

  while (visibleWidth(`${prefix}${ellipsis}${suffix}`) > maxWidth && suffix.length > 0) {
    suffix = takeSuffixToWidth(suffix, Math.max(0, visibleWidth(suffix) - 1));
  }
  while (visibleWidth(`${prefix}${ellipsis}${suffix}`) > maxWidth && prefix.length > 0) {
    prefix = takePrefixToWidth(prefix, Math.max(0, visibleWidth(prefix) - 1));
  }

  return `${prefix}${ellipsis}${suffix}`;
}

function truncatePathSegmentsToWidth(text: string, maxWidth: number): string | null {
  const separator = text.includes('/') ? '/' : text.includes('\\') ? '\\' : null;
  if (separator === null) return null;

  const parts = text.split(separator);
  if (parts.length < 3) return null;

  const last = parts.at(-1) ?? '';
  if (!last) return null;

  const first = parts[0] ?? '';
  const prefix = first === '' ? separator : `${first}${separator}`;
  const withFirst = `${prefix}...${separator}${last}`;
  if (visibleWidth(withFirst) <= maxWidth) return withFirst;

  const suffixOnly = `...${separator}${last}`;
  if (visibleWidth(suffixOnly) <= maxWidth) return suffixOnly;

  return null;
}

function takeSuffixToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;

  const chars = Array.from(text);
  let suffix = '';
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = `${chars[index]}${suffix}`;
    if (visibleWidth(next) > maxWidth) break;
    suffix = next;
  }
  return suffix;
}

function takePrefixToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;

  const chars = Array.from(text);
  let prefix = '';
  for (const char of chars) {
    const next = `${prefix}${char}`;
    if (visibleWidth(next) > maxWidth) break;
    prefix = next;
  }
  return prefix;
}

function cwdRelativeCandidate(inputPath: string, cwd: string | undefined): string | null {
  if (!cwd) {
    return null;
  }
  // Match on the native separator the input already uses. We don't
  // try to mix `/` and `\\` heuristics — if the caller's cwd is
  // POSIX and inputPath is Windows-style (or vice versa) we skip
  // rather than produce a confusing hybrid string.
  if (inputPath === cwd) {
    return '.';
  }
  if (inputPath.startsWith(`${cwd}/`)) {
    return inputPath.slice(cwd.length + 1);
  }
  if (inputPath.startsWith(`${cwd}\\`)) {
    return inputPath.slice(cwd.length + 1);
  }
  return null;
}
