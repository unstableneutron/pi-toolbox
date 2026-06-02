export interface WidthMeasurementOps {
  measure(text: string): number;
  truncate(text: string, maxWidth: number): string;
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

export function normalizeWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return 0;
  }
  return Math.max(0, Math.floor(width));
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
