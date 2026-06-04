function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && 'object' === typeof value ? (value as Record<string, unknown>) : undefined;
}

export function hasUserVisibleAssistantOutput(content: unknown): boolean {
  if (!Array.isArray(content)) return false;

  return content.some((part) => {
    const candidate = asRecord(part);
    if (!candidate) return false;
    if (candidate.type === 'toolCall') return true;
    return candidate.type === 'text' && 'string' === typeof candidate.text
      ? 0 < candidate.text.trim().length
      : false;
  });
}

export function hasAssistantToolCall(content: unknown): boolean {
  return Array.isArray(content)
    ? content.some((part) => asRecord(part)?.type === 'toolCall')
    : false;
}

function hasZeroOrEmptyUsage(usage: unknown): boolean {
  if (usage === undefined || usage === null) return true;
  if ('number' === typeof usage) return usage === 0;
  if ('object' !== typeof usage) return false;

  const numericValues: number[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [usage];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null) continue;
    if ('number' === typeof current) {
      numericValues.push(current);
      continue;
    }
    if ('object' !== typeof current) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) stack.push(...current);
    else stack.push(...Object.values(current));
  }

  return numericValues.every((value) => value === 0);
}

export function isSkippableEmptyFailedAssistantArtifact(message: unknown): boolean {
  const candidate = asRecord(message);
  return Boolean(
    candidate?.role === 'assistant' &&
    ('error' === candidate.stopReason || 'aborted' === candidate.stopReason) &&
    !hasUserVisibleAssistantOutput(candidate.content) &&
    hasZeroOrEmptyUsage(candidate.usage),
  );
}
