export interface WidthMeasurementOps {
  measure(text: string): number;
  truncate(text: string, maxWidth: number): string;
}

export interface StripTerminalControlOptions {
  preserveCsi?: boolean;
}

export interface OptionalSuffixChoice {
  suffix: string;
  primaryBudget: number;
}

export interface ChooseOptionalSuffixArgs {
  width?: number;
  fixedWidth: number;
  suffixes: string[];
  minPrimaryWidth?: number;
  preferredPrimaryWidth?: number;
}

export const DEFAULT_EXPAND_HINT_SUFFIXES = [' (ctrl+o to expand)', ' (ctrl+o)', ''];
const ESC = '\u001b';
const CSI = '\u009b';
const OSC = '\u009d';
const DCS = '\u0090';
const SOS = '\u0098';
const PM = '\u009e';
const APC = '\u009f';
const ST = '\u009c';
const BEL = '\u0007';

// Ported from Pi's private utils/ansi.ts shape, then expanded for C1
// OSC/DCS/SOS/PM/APC strings. We keep this local because those helpers are
// not exported by @earendil-works/pi-coding-agent's public package exports.
const STRING_TERMINATOR_PATTERN = String.raw`(?:${BEL}|${ESC}\\|${ST})`;
const OSC_PATTERN = String.raw`(?:${ESC}\][\s\S]*?${STRING_TERMINATOR_PATTERN}|${OSC}[\s\S]*?${STRING_TERMINATOR_PATTERN})`;
const STRING_CONTROL_PATTERN = String.raw`(?:${ESC}[P_X^][\s\S]*?(?:${ESC}\\|${ST})|[${DCS}${SOS}${PM}${APC}][\s\S]*?(?:${ESC}\\|${ST}))`;
const CSI_PATTERN = String.raw`(?:${ESC}\[[0-?]*[ -/]*[@-~]|${CSI}[0-?]*[ -/]*[@-~])`;
const ESC_PATTERN = String.raw`${ESC}[ -/]*[@-~]`;
const TERMINAL_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${OSC_PATTERN}|${STRING_CONTROL_PATTERN}|${CSI_PATTERN}|${ESC_PATTERN}`,
  'g',
);
const HAS_TERMINAL_CONTROL_SEQUENCE_PATTERN = new RegExp(
  String.raw`[${ESC}${CSI}${OSC}${DCS}${SOS}${PM}${APC}]`,
);

export function normalizeWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return 0;
  }
  return Math.max(0, Math.floor(width));
}

export function stripTerminalControlSequences(
  text: string,
  options: StripTerminalControlOptions | boolean = {},
): string {
  const preserveCsi = typeof options === 'boolean' ? options : options.preserveCsi === true;
  if (!preserveCsi) {
    return HAS_TERMINAL_CONTROL_SEQUENCE_PATTERN.test(text)
      ? text.replace(TERMINAL_CONTROL_SEQUENCE_PATTERN, '')
      : text;
  }

  const escape = ESC;
  const bell = String.fromCharCode(7);
  const stringTerminator = String.fromCharCode(0x9c);
  let output = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === String.fromCharCode(0x9b)) {
      const sequenceStart = index;
      index += 1;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      if (preserveCsi) {
        output += `${escape}[${text.slice(sequenceStart + 1, Math.min(index + 1, text.length))}`;
      }
      continue;
    }

    if (char === String.fromCharCode(0x9d)) {
      while (index < text.length) {
        if (text[index] === bell || text[index] === stringTerminator) break;
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (
      char === String.fromCharCode(0x90) ||
      char === String.fromCharCode(0x98) ||
      char === String.fromCharCode(0x9e) ||
      char === String.fromCharCode(0x9f)
    ) {
      while (index < text.length) {
        if (text[index] === stringTerminator) break;
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char !== escape) {
      output += char;
      continue;
    }

    const next = text[index + 1];
    if (next === ']') {
      index += 2;
      while (index < text.length) {
        if (text[index] === bell) break;
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next && 'P_X^'.includes(next)) {
      index += 2;
      while (index < text.length) {
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next === '[') {
      const sequenceStart = index;
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      if (preserveCsi) output += text.slice(sequenceStart, Math.min(index + 1, text.length));
      continue;
    }

    if (next) index += 1;
  }

  return output;
}

export function sanitizeBinaryOutput(text: string, preserveBackspace = false): string {
  return Array.from(text)
    .filter((char) => isRenderableCodePoint(char.codePointAt(0), preserveBackspace))
    .join('');
}

export function isRenderableCodePoint(
  code: number | undefined,
  preserveBackspace = false,
): boolean {
  if (code === undefined) return false;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (preserveBackspace && code === 0x08) return true;
  if (code <= 0x1f || code === 0x7f) return false;
  if (code >= 0x80 && code <= 0x9f) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code === 0xfffd) return false;
  if (isUnsafeFormatCodePoint(code)) return false;
  if (code >= 0xfff9 && code <= 0xfffb) return false;
  return true;
}

function isUnsafeFormatCodePoint(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

export function sanitizeRenderableText(text: string): string {
  return sanitizeBinaryOutput(stripTerminalControlSequences(text));
}

export function sanitizeRenderableLine(text: string): string {
  return sanitizeRenderableText(text).replace(/[\r\n]+/g, ' ');
}

export function clampRenderedLineToWidth(
  text: string,
  width: number,
  ops: WidthMeasurementOps,
): string {
  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) {
    return '';
  }

  if (ops.measure(text) <= safeWidth) {
    return text;
  }

  for (let targetWidth = safeWidth; targetWidth >= 0; targetWidth -= 1) {
    const candidate = ops.truncate(text, targetWidth);
    if (ops.measure(candidate) <= safeWidth) {
      return candidate;
    }
  }

  return '';
}

export function clampRenderedLinesToWidth(
  lines: string[],
  width: number,
  ops: WidthMeasurementOps,
): string[] {
  return lines.map((line) => clampRenderedLineToWidth(line, width, ops));
}

export function chooseOptionalSuffix(args: ChooseOptionalSuffixArgs): OptionalSuffixChoice {
  const safeWidth = normalizeWidth(args.width);
  const minPrimaryWidth = Math.max(1, args.minPrimaryWidth ?? 1);
  const preferredPrimaryWidth =
    typeof args.preferredPrimaryWidth === 'number' && Number.isFinite(args.preferredPrimaryWidth)
      ? Math.max(1, Math.floor(args.preferredPrimaryWidth))
      : undefined;
  const suffixes = args.suffixes.length > 0 ? args.suffixes : [''];

  if (safeWidth === 0) {
    return { suffix: suffixes[0] ?? '', primaryBudget: Number.POSITIVE_INFINITY };
  }

  if (preferredPrimaryWidth !== undefined && safeWidth - args.fixedWidth >= preferredPrimaryWidth) {
    const nonEmptySuffixes = suffixes.filter((suffix) => suffix.length > 0);
    for (const suffix of nonEmptySuffixes) {
      const primaryBudget = safeWidth - args.fixedWidth - suffix.length;
      if (primaryBudget >= preferredPrimaryWidth) {
        return { suffix, primaryBudget };
      }
    }

    const suffixBudget = safeWidth - args.fixedWidth - preferredPrimaryWidth;
    const firstSuffix = nonEmptySuffixes[0] ?? '';
    if (firstSuffix && suffixBudget > 0) {
      return { suffix: firstSuffix.slice(0, suffixBudget), primaryBudget: preferredPrimaryWidth };
    }

    for (const suffix of suffixes.filter((suffix) => suffix.length === 0)) {
      const primaryBudget = safeWidth - args.fixedWidth - suffix.length;
      if (primaryBudget >= preferredPrimaryWidth) {
        return { suffix, primaryBudget };
      }
    }
  }

  const fallbackSuffixes =
    preferredPrimaryWidth === undefined
      ? suffixes
      : [suffixes[0] ?? '', suffixes[suffixes.length - 1] ?? ''];
  for (const suffix of fallbackSuffixes) {
    const primaryBudget = safeWidth - args.fixedWidth - suffix.length;
    if (primaryBudget >= minPrimaryWidth) {
      return { suffix, primaryBudget };
    }
  }

  const fallbackSuffix = fallbackSuffixes[fallbackSuffixes.length - 1] ?? '';
  return {
    suffix: fallbackSuffix,
    primaryBudget: Math.max(1, safeWidth - args.fixedWidth - fallbackSuffix.length),
  };
}
