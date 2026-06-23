function tryParseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

function repairJsonPrefix(prefix: string): string | undefined {
  let source = prefix.trimEnd();
  if (!source) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if ((char === '}' || char === ']') && stack[stack.length - 1] === char) stack.pop();
  }

  if (inString) source += '"';
  while (/[:,]\s*$/.test(source)) source = source.replace(/[:,]\s*$/, '');
  source += stack.reverse().join('');
  source = source.replace(/,\s*([}\]])/g, '$1');
  return source;
}

export function parsePartialJson(source: string): unknown {
  const complete = tryParseJson(source);
  if (complete !== undefined) return complete;

  for (let end = source.length; end > 0; end--) {
    const repaired = repairJsonPrefix(source.slice(0, end));
    if (!repaired) continue;
    const parsed = tryParseJson(repaired);
    if (parsed !== undefined) return parsed;
  }

  throw new SyntaxError('Unable to parse partial JSON');
}
