import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface ConditionalContextModel {
  provider?: string | undefined;
  id?: string | undefined;
  api?: string | undefined;
  name?: string | undefined;
}

export interface ConditionalContextResult {
  text: string;
  changed: boolean;
  errors?: string[] | undefined;
}

export type ConditionalKey = 'class' | 'provider' | 'id' | 'api' | 'name' | 'model';

export interface ConditionalClause {
  key: ConditionalKey;
  op: 'includes';
  values: string[];
  negated: boolean;
}

export interface ConditionalGroup {
  all: ConditionalClause[];
}

export interface ConditionalExpression {
  any: ConditionalGroup[];
}

interface ConditionalFrame {
  parentActive: boolean;
  conditionActive: boolean;
  elseSeen: boolean;
}

const IF_DIRECTIVE = /^\s*<!--\s*pi:if\s+(.+?)\s*-->\s*$/i;
const ELSE_DIRECTIVE = /^\s*<!--\s*pi:else\s*-->\s*$/i;
const ENDIF_DIRECTIVE = /^\s*<!--\s*pi:endif\s*-->\s*$/i;
const PI_DIRECTIVE = /^\s*<!--\s*pi:([a-z][\w-]*)(?:\s+.*?)?\s*-->\s*$/i;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function splitValues(value: string): string[] {
  return value
    .split(/[|,]/g)
    .map((part) => normalized(part))
    .filter(Boolean);
}

function modelFields(model: ConditionalContextModel | undefined): Record<string, string> {
  const provider = normalized(model?.provider ?? '');
  const id = normalized(model?.id ?? '');
  const api = normalized(model?.api ?? '');
  const name = normalized(model?.name ?? '');
  const full = [provider, id].filter(Boolean).join('/');
  return { provider, id, api, name, full, model: [provider, id, api, name].join(' ') };
}

function modelClasses(fields: Record<string, string>): Set<string> {
  const haystack = `${fields.provider} ${fields.id} ${fields.api} ${fields.name} ${fields.full}`;
  const classes = new Set<string>();

  if (/anthropic|claude|sonnet|opus|haiku/.test(haystack)) classes.add('claude');
  if (/openai|gpt/.test(haystack)) classes.add('openai');
  if (/codex/.test(haystack)) classes.add('codex');
  if (/google|gemini/.test(haystack)) classes.add('gemini');

  for (const part of haystack.split(/[\s/_:-]+/g)) {
    if (part) classes.add(part);
  }

  return classes;
}

function valueMatches(value: string, candidates: string[]): boolean {
  if (!value) return false;
  return candidates.some((candidate) => value === candidate || value.includes(candidate));
}

function normalizeKey(key: string): ConditionalKey | undefined {
  const normalizedKey = normalized(key).replace(/^model\./, '');
  if (
    normalizedKey === 'class' ||
    normalizedKey === 'provider' ||
    normalizedKey === 'id' ||
    normalizedKey === 'api' ||
    normalizedKey === 'name' ||
    normalizedKey === 'model'
  ) {
    return normalizedKey;
  }
  return undefined;
}

function parseClause(clause: string): ConditionalClause | undefined {
  const negated = clause.startsWith('!') || clause.toLowerCase().startsWith('not:');
  const body = negated ? clause.replace(/^(?:!|not:)\s*/i, '') : clause;
  const match = /^([a-z][a-z0-9_.-]*)\s*(?::|=|~=|\*=)\s*(.+)$/i.exec(body);
  const key = normalizeKey(match?.[1] ?? 'model');
  if (!key) return undefined;
  const values = splitValues(match?.[2] ?? body);
  if (values.length === 0) return undefined;
  return { key, op: 'includes', values, negated };
}

export function parseConditionExpression(expression: string): ConditionalExpression | undefined {
  const rawClauses = expression.trim().split(/\s+/g).filter(Boolean);
  if (rawClauses.length === 0 || rawClauses.includes('||')) return undefined;

  const all: ConditionalClause[] = [];
  for (const rawClause of rawClauses) {
    const clause = parseClause(rawClause);
    if (!clause) return undefined;
    all.push(clause);
  }

  return { any: [{ all }] };
}

function clauseMatches(
  clause: ConditionalClause,
  model: ConditionalContextModel | undefined,
): boolean {
  const fields = modelFields(model);
  const classes = modelClasses(fields);

  let matched = false;
  if (clause.key === 'class') {
    matched = clause.values.some((value) => classes.has(value));
  } else if (clause.key === 'provider') {
    matched = valueMatches(fields.provider, clause.values);
  } else if (clause.key === 'id') {
    matched = valueMatches(fields.id, clause.values);
  } else if (clause.key === 'api') {
    matched = valueMatches(fields.api, clause.values);
  } else if (clause.key === 'name') {
    matched = valueMatches(fields.name, clause.values);
  } else {
    matched = clause.values.some(
      (value) =>
        classes.has(value) ||
        valueMatches(fields.model, [value]) ||
        valueMatches(fields.full, [value]),
    );
  }

  return clause.negated ? !matched : matched;
}

function expressionMatches(
  expression: ConditionalExpression,
  model: ConditionalContextModel | undefined,
): boolean {
  return expression.any.some((group) => group.all.every((clause) => clauseMatches(clause, model)));
}

export function conditionMatches(
  expression: string,
  model: ConditionalContextModel | undefined,
): boolean {
  const parsed = parseConditionExpression(expression);
  return parsed ? expressionMatches(parsed, model) : false;
}

function failClosedText(lines: string[], firstDirectiveIndex: number, errors: string[]): string {
  const prefix = lines.slice(0, Math.max(0, firstDirectiveIndex));
  return [
    ...prefix,
    '',
    '<!-- pi-conditional-context: malformed conditional context removed -->',
    ...errors.map((error) => `<!-- ${error} -->`),
  ].join('\n');
}

export function processConditionalContext(
  text: string,
  model: ConditionalContextModel | undefined,
): ConditionalContextResult {
  const lines = text.split(/\r?\n/g);
  const output: string[] = [];
  const stack: ConditionalFrame[] = [];
  let active = true;
  let changed = false;
  let firstDirectiveIndex: number | undefined;
  const errors: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (PI_DIRECTIVE.test(line) && firstDirectiveIndex === undefined) firstDirectiveIndex = index;

    const ifMatch = IF_DIRECTIVE.exec(line);
    if (ifMatch) {
      const expression = parseConditionExpression(ifMatch[1]!);
      if (!expression) {
        errors.push(`pi-conditional-context: invalid condition on line ${index + 1}`);
        break;
      }
      const conditionActive = expressionMatches(expression, model);
      stack.push({ parentActive: active, conditionActive, elseSeen: false });
      active = active && conditionActive;
      changed = true;
      continue;
    }

    if (ELSE_DIRECTIVE.test(line)) {
      const frame = stack.at(-1);
      if (!frame || frame.elseSeen) {
        errors.push(`pi-conditional-context: unexpected else on line ${index + 1}`);
        break;
      }
      frame.elseSeen = true;
      active = frame.parentActive && !frame.conditionActive;
      changed = true;
      continue;
    }

    if (ENDIF_DIRECTIVE.test(line)) {
      const frame = stack.pop();
      if (!frame) {
        errors.push(`pi-conditional-context: unexpected endif on line ${index + 1}`);
        break;
      }
      active = frame.parentActive;
      changed = true;
      continue;
    }

    if (PI_DIRECTIVE.test(line)) {
      errors.push(`pi-conditional-context: unknown directive on line ${index + 1}`);
      break;
    }

    if (active) output.push(line);
  }

  if (stack.length > 0 && errors.length === 0) {
    errors.push('pi-conditional-context: unclosed conditional block');
  }

  if (errors.length > 0) {
    return {
      text: failClosedText(lines, firstDirectiveIndex ?? 0, errors),
      changed: true,
      errors,
    };
  }

  return { text: output.join('\n'), changed };
}

export default function piConditionalContextExtension(pi: ExtensionAPI): void {
  let lastWarningKey: string | undefined;

  pi.on('before_agent_start', (event, ctx) => {
    const result = processConditionalContext(
      event.systemPrompt,
      ctx.model as ConditionalContextModel,
    );
    if (result.errors?.length && ctx.hasUI) {
      const key = result.errors.join('\n');
      if (key !== lastWarningKey) {
        lastWarningKey = key;
        ctx.ui.notify(key, 'warning');
      }
    }
    return result.changed ? { systemPrompt: result.text } : undefined;
  });
}
