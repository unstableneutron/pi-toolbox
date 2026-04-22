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
