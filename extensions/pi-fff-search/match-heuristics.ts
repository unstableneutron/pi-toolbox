const DEFAULT_MATCH_TEXT_MAX_CHARS = 280;
const RISKY_MATCH_TEXT_MAX_CHARS = 160;

const RISKY_MATCH_EXTENSIONS = new Set(['.json', '.jsonl', '.log', '.ndjson', '.min.js']);

const RISKY_MATCH_PATH_SEGMENTS = [
  '/.local/share/',
  '/threads/',
  '/sessions/',
  '/history/',
  '/node_modules/',
  '/dist/',
  '/coverage/',
  '/.cache/',
  '/Library/',
  '/tmp/',
];

export function extensionForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.min.js')) {
    return '.min.js';
  }
  const dotIndex = lower.lastIndexOf('.');
  return dotIndex >= 0 ? lower.slice(dotIndex) : '';
}

export function isRiskyMatchPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    RISKY_MATCH_EXTENSIONS.has(extensionForPath(normalized)) ||
    RISKY_MATCH_PATH_SEGMENTS.some((segment) => normalized.includes(segment))
  );
}

export function clampMatchText(text: string, path?: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const limit = isRiskyMatchPath(path ?? '')
    ? RISKY_MATCH_TEXT_MAX_CHARS
    : DEFAULT_MATCH_TEXT_MAX_CHARS;

  if (compact.length <= limit) {
    return compact;
  }

  return `${compact.slice(0, limit).trimEnd()} … [truncated, ${compact.length} chars total]`;
}

function normalizeExtensionFilter(extension: string): string {
  return extension.toLowerCase().replace(/^\./, '');
}

export function matchesAllowedExtensions(path: string, extensions: string[]): boolean {
  if (extensions.length === 0) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  return extensions.some((candidate) => {
    const normalizedCandidate = normalizeExtensionFilter(candidate);
    return normalizedPath.endsWith(`.${normalizedCandidate}`);
  });
}
