import { stripVTControlCharacters } from 'node:util';

import {
  getMarkdownTheme,
  highlightCode,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Text, type Component } from '@earendil-works/pi-tui';

import type { JsonObject, JsonValue } from './types';

export type ExecutorRendererKind =
  | 'search'
  | 'describe'
  | 'execute'
  | 'list-guides'
  | 'guide'
  | 'job'
  | 'cancel-job'
  | 'read-output'
  | 'proxy';

export interface ExecutorRendererConfig {
  kind: ExecutorRendererKind;
  label: string;
}

interface ExecutorRenderDetails {
  endpoint?: string;
  source?: string;
  structuredContent?: JsonValue;
  outputId?: string;
  outputPage?: JsonValue;
}

interface ExecutorRenderResult {
  content: Array<{ type: string; text?: string }>;
  details?: ExecutorRenderDetails;
}

interface ExecutorRenderContext {
  expanded: boolean;
  isError: boolean;
  lastComponent?: Component;
}

interface ExecutorRenderer {
  renderCall(args: unknown, theme: Theme, context: ExecutorRenderContext): Component;
  renderResult(
    result: ExecutorRenderResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ExecutorRenderContext,
  ): Component;
}

const MAX_COLLAPSED_TEXT = 120;
const MAX_EXPANDED_CODE_LINES = 60;
const MAX_EXPANDED_LOG_LINES = 20;
const MAX_EXPANDED_ERROR_LINES = 24;
const SENSITIVE_ASSIGNMENT =
  /(\b(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key|password|passwd|secret|cookie|set-cookie)\b\s*[:=]\s*)(["'])([^\n]*?)\2/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function stripOtherControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code > 31;
    })
    .join('');
}

function safeDisplayText(value: unknown): string {
  return stripOtherControls(stripVTControlCharacters(textValue(value)))
    .replace(BIDI_CONTROL, '')
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(SENSITIVE_ASSIGNMENT, '$1$2[REDACTED]$2')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]');
}

function compactText(value: unknown, maximum = MAX_COLLAPSED_TEXT): string {
  const normalized = safeDisplayText(value).replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : normalized;
}

function shortId(value: unknown): string {
  const id = compactText(value, 48);
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function textComponent(text: string, context: ExecutorRenderContext): Text {
  const previous = context.lastComponent;
  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }
  return new Text(text, 0, 0);
}

function title(config: ExecutorRendererConfig, theme: Theme): string {
  return theme.fg('toolTitle', theme.bold(config.label));
}

function textContent(result: ExecutorRenderResult): string {
  return result.content
    .filter((item): item is { type: string; text: string } => typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function stripOutputNotice(text: string): string {
  return text
    .replace(/\n\n\[(?:Output truncated\.|Output page\.|End of output\.)[^\]]*\]\s*$/s, '')
    .trimEnd();
}

function structuredContent(result: ExecutorRenderResult): JsonValue | undefined {
  return result.details?.structuredContent;
}

function remoteEnvelope(result: ExecutorRenderResult): JsonObject | undefined {
  const structured = asObject(structuredContent(result));
  return structured && typeof structured.status === 'string' ? structured : undefined;
}

function displayValue(result: ExecutorRenderResult): JsonValue {
  const content = textContent(result);
  if (!result.details?.outputId) {
    const parsed = parseJson(content);
    if (parsed !== undefined) return parsed;
    return content;
  }

  const structured = asObject(structuredContent(result));
  if (structured && 'result' in structured) return structured.result ?? null;
  return structuredContent(result) ?? stripOutputNotice(content);
}

function runningValue(result: ExecutorRenderResult): JsonObject | undefined {
  const structured = asObject(structuredContent(result));
  if (structured?.state === 'running') return structured;
  const parsed = asObject(parseJson(textContent(result)));
  return parsed?.state === 'running' ? parsed : undefined;
}

function resultSummary(value: JsonValue): string {
  if (value === null) return 'No result';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'string') {
    const summary = compactText(value);
    return summary ? JSON.stringify(summary) : 'Empty result';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const items = value.items;
  const total = value.total;
  if (Array.isArray(items) && typeof total === 'number') {
    return total === items.length
      ? `${items.length} match${items.length === 1 ? '' : 'es'}`
      : `${items.length} of ${total} matches`;
  }
  if (typeof value.url === 'string') return 'URL ready';

  const keys = Object.keys(value);
  if (keys.length === 0) return 'Empty object';
  const keyPreview = keys.slice(0, 3).join(', ');
  return `${keys.length} field${keys.length === 1 ? '' : 's'} · ${keyPreview}${keys.length > 3 ? ', …' : ''}`;
}

function resultSuffix(result: ExecutorRenderResult, theme: Theme): string {
  const envelope = remoteEnvelope(result);
  const emitted = typeof envelope?.emitted === 'number' ? envelope.emitted : 0;
  const logs = Array.isArray(envelope?.logs) ? envelope.logs.length : 0;
  const parts: string[] = [];
  if (emitted > 0) parts.push(`${emitted} emitted`);
  if (logs > 0) parts.push(`${logs} log${logs === 1 ? '' : 's'}`);
  if (result.details?.outputId) parts.push('output truncated');
  return parts.length > 0 ? theme.fg('dim', ` · ${parts.join(' · ')}`) : '';
}

function displayEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return compactText(value);
  }
}

function metadataLines(result: ExecutorRenderResult, theme: Theme): string[] {
  const details = result.details;
  if (!details) return [];
  const lines: string[] = [];
  if (details.endpoint) {
    lines.push(
      `${theme.fg('dim', 'Endpoint')}  ${theme.fg('muted', displayEndpoint(details.endpoint))}`,
    );
  }
  if (details.source) {
    lines.push(`${theme.fg('dim', 'Source')}    ${theme.fg('muted', compactText(details.source))}`);
  }
  const page = asObject(details.outputPage);
  if (details.outputId) {
    lines.push(
      `${theme.fg('dim', 'Output ID')} ${theme.fg('muted', compactText(details.outputId, 80))}`,
    );
  }
  if (typeof page?.nextOffset === 'number') {
    lines.push(`${theme.fg('dim', 'Next')}      ${theme.fg('muted', String(page.nextOffset))}`);
  }
  if (typeof page?.totalBytes === 'number') {
    lines.push(
      `${theme.fg('dim', 'Total')}     ${theme.fg('muted', formatBytes(page.totalBytes))}`,
    );
  }
  return lines;
}

function highlighted(value: string, language: string): string {
  return highlightCode(value, language).join('\n');
}

function expandedResultText(result: ExecutorRenderResult, theme: Theme): string {
  const raw = stripOutputNotice(safeDisplayText(textContent(result)));
  const parsed = parseJson(raw);
  const body = parsed === undefined ? raw : JSON.stringify(parsed, null, 2);
  const renderedBody = body
    ? parsed === undefined
      ? theme.fg('toolOutput', body)
      : highlighted(body, 'json')
    : '';

  const sections: string[] = [];
  if (renderedBody) sections.push(renderedBody);

  const envelope = remoteEnvelope(result);
  if (Array.isArray(envelope?.logs) && envelope.logs.length > 0) {
    const logs = envelope.logs
      .slice(0, MAX_EXPANDED_LOG_LINES)
      .map((line) => safeDisplayText(line));
    if (envelope.logs.length > logs.length) {
      logs.push(`… ${envelope.logs.length - logs.length} more log lines`);
    }
    sections.push(
      `${theme.fg('muted', 'Logs')}\n${logs.map((line) => `  ${theme.fg('dim', line)}`).join('\n')}`,
    );
  }

  const metadata = metadataLines(result, theme);
  if (metadata.length > 0) sections.push(metadata.join('\n'));
  return sections.join('\n\n');
}

function renderError(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const lines = safeDisplayText(textContent(result))
    .split('\n')
    .map((line) => line.trimEnd());
  const first = (lines.find((line) => line.trim()) ?? 'Executor failed').replace(
    /^(?:Error:\s*)+/i,
    '',
  );
  let text = theme.fg('error', `✗ ${compactText(first)}`);
  if (expanded && lines.length > 1) {
    const detailLines = lines.slice(1, MAX_EXPANDED_ERROR_LINES);
    if (lines.length > MAX_EXPANDED_ERROR_LINES) {
      detailLines.push(`… ${lines.length - MAX_EXPANDED_ERROR_LINES} more lines`);
    }
    text += `\n\n${detailLines.map((line) => theme.fg('dim', line)).join('\n')}`;
  }
  return textComponent(text, context);
}

function partialLabel(kind: ExecutorRendererKind): string {
  switch (kind) {
    case 'search':
      return 'Searching…';
    case 'describe':
      return 'Describing…';
    case 'guide':
    case 'list-guides':
      return 'Loading…';
    case 'job':
      return 'Waiting…';
    case 'execute':
      return 'Executing…';
    default:
      return 'Running…';
  }
}

function renderPartial(
  config: ExecutorRendererConfig,
  result: ExecutorRenderResult,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const raw = safeDisplayText(textContent(result));
  const separator = raw.indexOf(':');
  const progress = separator >= 0 ? compactText(raw.slice(separator + 1)) : '';
  const suffix = progress ? theme.fg('dim', ` · ${progress}`) : '';
  return textComponent(theme.fg('warning', partialLabel(config.kind)) + suffix, context);
}

function toolPaths(code: string): string[] {
  const paths: string[] = [];
  const pattern =
    /tools(?:\[\s*["'`]([^"'`]+)["'`]\s*\]|\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+))/g;
  for (const match of code.matchAll(pattern)) {
    const path = match[1] ?? match[2];
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function compactToolPath(path: string): string {
  return safeDisplayText(path).replace(/^executor\./, '');
}

function renderExecuteCall(
  config: ExecutorRendererConfig,
  args: Record<string, unknown>,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const code = typeof args.code === 'string' ? args.code : '';
  const paths = toolPaths(code);
  const lineCount = code ? code.split(/\r?\n/).length : 0;
  let summary = 'TypeScript';
  if (paths.length === 1) summary = compactToolPath(paths[0]!);
  if (paths.length > 1) summary = `${compactToolPath(paths[0]!)} +${paths.length - 1}`;

  let text = `${title(config, theme)}  ${theme.fg('accent', summary)}`;
  if (lineCount > 0) {
    text += theme.fg('dim', ` · ${lineCount} line${lineCount === 1 ? '' : 's'}`);
  }
  if (!context.expanded || !code) return textComponent(text, context);

  const settings: string[] = [];
  if (typeof args.waitMs === 'number') settings.push(`wait ${formatDuration(args.waitMs)}`);
  if (typeof args.timeoutMs === 'number')
    settings.push(`timeout ${formatDuration(args.timeoutMs)}`);
  if (settings.length > 0) text += `\n  ${theme.fg('dim', settings.join(' · '))}`;

  const lines = safeDisplayText(code).split(/\r?\n/);
  const visible = lines.slice(0, MAX_EXPANDED_CODE_LINES);
  let codePreview = visible.join('\n');
  if (lines.length > visible.length) {
    codePreview += `\n// … ${lines.length - visible.length} more lines`;
  }
  text += `\n\n${highlighted(codePreview, 'typescript')}`;
  return textComponent(text, context);
}

function renderProxyCall(
  config: ExecutorRendererConfig,
  args: Record<string, unknown>,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  let text = title(config, theme);
  const safeParts: string[] = [];
  for (const key of ['title', 'artifactId', 'id']) {
    if (typeof args[key] === 'string') safeParts.push(`${key}=${compactText(args[key], 60)}`);
  }
  if (Array.isArray(args.edits)) safeParts.push(`${args.edits.length} edits`);
  if (typeof args.code === 'string') {
    const lines = args.code.split(/\r?\n/).length;
    safeParts.push(`${lines} code line${lines === 1 ? '' : 's'}`);
  }
  if (safeParts.length > 0) text += `  ${theme.fg('dim', safeParts.join(' · '))}`;

  if (context.expanded) {
    const hidden = Object.keys(args).filter(
      (key) => !['title', 'artifactId', 'id', 'edits', 'code'].includes(key),
    );
    if (hidden.length > 0) {
      text += `\n  ${theme.fg('dim', `Other parameters: ${hidden.join(', ')}`)}`;
    }
  }
  return textComponent(text, context);
}

function renderCall(
  config: ExecutorRendererConfig,
  rawArgs: unknown,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const args = asObject(rawArgs) ?? {};
  if (config.kind === 'execute') return renderExecuteCall(config, args, theme, context);
  if (config.kind === 'proxy') return renderProxyCall(config, args, theme, context);

  let text = title(config, theme);
  switch (config.kind) {
    case 'search': {
      if (typeof args.query === 'string')
        text += `  ${theme.fg('accent', compactText(args.query))}`;
      if (context.expanded) {
        const options: string[] = [];
        if (Array.isArray(args.kinds)) {
          options.push(`kinds=${args.kinds.map((kind) => compactText(kind, 30)).join(',')}`);
        }
        if (typeof args.namespace === 'string')
          options.push(`namespace=${compactText(args.namespace)}`);
        if (typeof args.limit === 'number') options.push(`limit=${args.limit}`);
        if (args.load === true) options.push('load=true');
        if (args.cursor) options.push('cursor=set');
        if (options.length > 0) text += `\n  ${theme.fg('dim', options.join(' · '))}`;
      }
      break;
    }
    case 'describe':
      if (typeof args.path === 'string') text += `  ${theme.fg('accent', compactText(args.path))}`;
      break;
    case 'guide':
      if (typeof args.id === 'string') text += `  ${theme.fg('accent', compactText(args.id))}`;
      break;
    case 'job':
    case 'cancel-job':
      if (typeof args.jobId === 'string') text += `  ${theme.fg('accent', shortId(args.jobId))}`;
      if (context.expanded && typeof args.waitMs === 'number') {
        text += theme.fg('dim', ` · wait ${formatDuration(args.waitMs)}`);
      }
      break;
    case 'read-output':
      if (typeof args.outputId === 'string')
        text += `  ${theme.fg('accent', shortId(args.outputId))}`;
      if (context.expanded) {
        const page: string[] = [];
        if (typeof args.offset === 'number') page.push(`offset=${args.offset}`);
        if (typeof args.limit === 'number') page.push(`limit=${args.limit}`);
        if (page.length > 0) text += theme.fg('dim', ` · ${page.join(' · ')}`);
      }
      break;
    default:
      break;
  }
  return textComponent(text, context);
}

function renderRunning(
  running: JsonObject,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const jobId = typeof running.jobId === 'string' ? running.jobId : '';
  let text = theme.fg('warning', '◌ Still running');
  if (jobId)
    text += theme.fg('dim', ` · job ${expanded ? compactText(jobId, 80) : shortId(jobId)}`);
  if (typeof running.retryAfterMs === 'number') {
    text += theme.fg('dim', ` · retry in ${formatDuration(running.retryAfterMs)}`);
  }
  return textComponent(text, context);
}

function renderSearchResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const value = asObject(parseJson(textContent(result))) ?? asObject(displayValue(result));
  const items = Array.isArray(value?.items) ? value.items.map(asObject).filter(Boolean) : [];
  const total = typeof value?.total === 'number' ? value.total : items.length;
  let text = theme.fg(
    items.length > 0 ? 'success' : 'dim',
    items.length === total
      ? `${items.length} match${items.length === 1 ? '' : 'es'}`
      : `${items.length} of ${total} matches`,
  );
  if (!expanded) return textComponent(text, context);

  for (const item of items.slice(0, 20)) {
    const path = compactText(item?.path, 140) || '(unknown tool)';
    const kind = compactText(item?.kind, 30);
    const state = compactText(item?.state, 30);
    const tags = [kind, state].filter(Boolean).join(' · ');
    text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', path)}`;
    if (tags) text += theme.fg('dim', `  ${tags}`);
    const summary = compactText(item?.summary, 180);
    if (summary) text += `\n    ${theme.fg('dim', summary)}`;
  }
  const metadata = metadataLines(result, theme);
  if (metadata.length > 0) text += `\n\n${metadata.join('\n')}`;
  return textComponent(text, context);
}

function renderDescribeResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const value = asObject(parseJson(textContent(result))) ?? asObject(displayValue(result));
  let text = theme.fg('success', '✓ Contract ready');
  if (!expanded || !value) return textComponent(text, context);

  const summary = compactText(value.summary, 240);
  if (summary) text += `\n  ${theme.fg('dim', summary)}`;
  for (const [label, key] of [
    ['Input', 'input'],
    ['Data', 'data'],
  ] as const) {
    if (typeof value[key] === 'string') {
      text += `\n\n${theme.fg('muted', label)}\n${highlighted(safeDisplayText(value[key]), 'typescript')}`;
    }
  }
  const metadata = metadataLines(result, theme);
  if (metadata.length > 0) text += `\n\n${metadata.join('\n')}`;
  return textComponent(text, context);
}

function renderListGuidesResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const value = asObject(parseJson(textContent(result))) ?? asObject(displayValue(result));
  const items = Array.isArray(value?.items) ? value.items.map(asObject).filter(Boolean) : [];
  let text = theme.fg('success', `${items.length} guide${items.length === 1 ? '' : 's'}`);
  if (expanded) {
    for (const item of items) {
      text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', compactText(item?.id, 80))}`;
      const summary = compactText(item?.summary, 180);
      if (summary) text += theme.fg('dim', ` — ${summary}`);
    }
  }
  return textComponent(text, context);
}

function renderGuideResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const markdown = safeDisplayText(textContent(result));
  const lines = markdown ? markdown.split('\n').length : 0;
  const summary = theme.fg('success', `✓ Guide loaded${lines > 0 ? ` · ${lines} lines` : ''}`);
  if (!expanded || !markdown) return textComponent(summary, context);

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Markdown(markdown, 0, 1, getMarkdownTheme()));
  return container;
}

function renderCancelResult(
  result: ExecutorRenderResult,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const value = asObject(parseJson(textContent(result))) ?? asObject(displayValue(result));
  const cancelled = value?.cancelled === true;
  return textComponent(
    cancelled ? theme.fg('success', '✓ Job cancelled') : theme.fg('dim', 'Job was not active'),
    context,
  );
}

function renderReadOutputResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const metadata = asObject(structuredContent(result));
  const total = typeof metadata?.totalBytes === 'number' ? metadata.totalBytes : undefined;
  const hasMore = metadata?.hasMore === true;
  let text = theme.fg(
    'success',
    `✓ Output page${total === undefined ? '' : ` · ${formatBytes(total)}`}`,
  );
  if (hasMore) text += theme.fg('dim', ' · more available');
  if (!expanded) return textComponent(text, context);

  const content = stripOutputNotice(safeDisplayText(textContent(result)));
  if (content) text += `\n\n${theme.fg('toolOutput', content)}`;
  if (metadata) {
    const page: string[] = [];
    if (typeof metadata.offset === 'number') page.push(`offset ${metadata.offset}`);
    if (typeof metadata.nextOffset === 'number') page.push(`next ${metadata.nextOffset}`);
    if (typeof metadata.totalBytes === 'number')
      page.push(`total ${formatBytes(metadata.totalBytes)}`);
    if (page.length > 0) text += `\n\n${theme.fg('dim', page.join(' · '))}`;
  }
  return textComponent(text, context);
}

function renderGeneralResult(
  result: ExecutorRenderResult,
  expanded: boolean,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  const value = displayValue(result);
  let text = theme.fg('success', `✓ ${resultSummary(value)}`) + resultSuffix(result, theme);
  if (expanded) {
    const detail = expandedResultText(result, theme);
    if (detail) text += `\n\n${detail}`;
  }
  return textComponent(text, context);
}

function renderResult(
  config: ExecutorRendererConfig,
  result: ExecutorRenderResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ExecutorRenderContext,
): Component {
  if (options.isPartial) return renderPartial(config, result, theme, context);
  if (context.isError) return renderError(result, options.expanded, theme, context);

  const running = runningValue(result);
  if (running) return renderRunning(running, options.expanded, theme, context);

  switch (config.kind) {
    case 'search':
      return renderSearchResult(result, options.expanded, theme, context);
    case 'describe':
      return renderDescribeResult(result, options.expanded, theme, context);
    case 'list-guides':
      return renderListGuidesResult(result, options.expanded, theme, context);
    case 'guide':
      return renderGuideResult(result, options.expanded, theme, context);
    case 'cancel-job':
      return renderCancelResult(result, theme, context);
    case 'read-output':
      return renderReadOutputResult(result, options.expanded, theme, context);
    default:
      return renderGeneralResult(result, options.expanded, theme, context);
  }
}

export function createExecutorRenderer(config: ExecutorRendererConfig): ExecutorRenderer {
  return {
    renderCall: (args, theme, context) => renderCall(config, args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderResult(config, result, options, theme, context),
  };
}
