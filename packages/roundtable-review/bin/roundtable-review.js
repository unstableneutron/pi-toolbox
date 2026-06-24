#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let piCodingAgentSdkPromise;

const THINKING_LEVEL_ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['extra_high', 'xhigh'],
  ['extrahigh', 'xhigh'],
  ['max', 'xhigh'],
]);
const DEFAULT_REVIEWER_MODELS = [
  'openai/gpt-5.5:xhigh',
  'anthropic/claude-opus-4-8:xhigh',
  'google/gemini-3.1-pro-preview:xhigh',
];
const DEFAULT_SYNTHESIS_MODEL = 'openai/gpt-5.5:xhigh';
const DEFAULT_STATUS_INTERVAL_MS = 60_000;
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

function usage() {
  return `roundtable-review - run model-diverse Pi reviewer sessions

Usage:
  roundtable-review [options] [review request]
  git diff | roundtable-review --stdin "Review this diff"

Options:
  --cwd <dir>                 Project directory to review (default: cwd)
  --models <list>             Comma-separated reviewer model specs (max 6)
  --synth-model <spec>        Synthesis model (default: ${DEFAULT_SYNTHESIS_MODEL})
  --diff                      Include unstaged and staged git diffs (default)
  --staged                    Include only staged git diff
  --no-diff                   Do not collect git diffs
  --path, --paths <paths>     File path(s) to focus, comma-separated or repeatable
  --stdin                     Read stdin as additional review material
  --no-stdin                  Ignore piped stdin
  --format <markdown|json>    Output format (default: markdown)
  --output <path>             Also write the final output to a file
  --timeout-ms <ms>           Per-reviewer timeout (default: 900000)
  --synthesis-timeout-ms <ms> Synthesis timeout (default: 600000)
  --status-interval-ms <ms>   Periodic live status interval on stderr (default: ${DEFAULT_STATUS_INTERVAL_MS})
  --status                    Enable periodic live status output
  --no-status                 Disable periodic live status output
  --max-diff-bytes <bytes>    Max bytes per collected diff section (default: 180000)
  --approve                   Trust project-local resources for this SDK run
  --no-extensions             Disable Pi extension loading (enabled by default)
  --no-skills                 Disable Pi skill loading (enabled by default)
  --verbose                   Print progress to stderr
  -h, --help                  Show this help

Model specs use provider/model[:thinking], for example:
  openai/gpt-5.5:xhigh, anthropic/claude-opus-4-8:max

Thinking aliases: max, extra-high, extra_high, and extrahigh all map to Pi's xhigh.

Default reviewer models:
${DEFAULT_REVIEWER_MODELS.map((model) => `  - ${model}`).join('\n')}
`;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    models: DEFAULT_REVIEWER_MODELS,
    synthModel: DEFAULT_SYNTHESIS_MODEL,
    collectDiff: true,
    stagedOnly: false,
    paths: [],
    readStdin: undefined,
    format: 'markdown',
    output: undefined,
    reviewerTimeoutMs: 15 * 60 * 1000,
    synthesisTimeoutMs: 10 * 60 * 1000,
    statusEnabled: true,
    statusIntervalMs: DEFAULT_STATUS_INTERVAL_MS,
    maxDiffBytes: 180_000,
    approve: false,
    loadExtensions: true,
    loadSkills: true,
    verbose: false,
    requestParts: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.requestParts.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      options.requestParts.push(arg);
      continue;
    }
    const readValue = (name) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--cwd':
        options.cwd = readValue(arg);
        break;
      case '--models':
      case '--reviewer-models':
        options.models = splitList(readValue(arg));
        break;
      case '--synth-model':
      case '--synthesis-model':
        options.synthModel = readValue(arg);
        break;
      case '--diff':
        options.collectDiff = true;
        options.stagedOnly = false;
        break;
      case '--staged':
        options.collectDiff = true;
        options.stagedOnly = true;
        break;
      case '--no-diff':
        options.collectDiff = false;
        break;
      case '--path':
      case '--paths':
        options.paths.push(...splitList(readValue(arg)));
        break;
      case '--stdin':
        options.readStdin = true;
        break;
      case '--no-stdin':
        options.readStdin = false;
        break;
      case '--format':
        options.format = readValue(arg);
        break;
      case '--output':
        options.output = readValue(arg);
        break;
      case '--timeout-ms':
        options.reviewerTimeoutMs = parsePositiveInteger(readValue(arg), arg);
        break;
      case '--synthesis-timeout-ms':
        options.synthesisTimeoutMs = parsePositiveInteger(readValue(arg), arg);
        break;
      case '--status':
        options.statusEnabled = true;
        break;
      case '--no-status':
        options.statusEnabled = false;
        break;
      case '--status-interval-ms':
        options.statusIntervalMs = parsePositiveInteger(readValue(arg), arg);
        break;
      case '--max-diff-bytes':
        options.maxDiffBytes = parsePositiveInteger(readValue(arg), arg);
        break;
      case '--approve':
        options.approve = true;
        break;
      case '--extensions':
        options.loadExtensions = true;
        break;
      case '--no-extensions':
        options.loadExtensions = false;
        break;
      case '--skills':
        options.loadSkills = true;
        break;
      case '--no-skills':
        options.loadSkills = false;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.cwd = resolve(options.cwd);
  options.models = normalizeReviewerModelList(options.models);
  options.paths = [...new Set(options.paths.filter(Boolean))];

  if (options.format !== 'markdown' && options.format !== 'json') {
    throw new Error(`--format must be "markdown" or "json", got ${options.format}`);
  }
  return options;
}

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function normalizeReviewerModelList(models) {
  const deduped = [];
  const seen = new Set();
  for (const model of models) {
    const normalized = normalizeModelSpec(model).spec;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  if (deduped.length === 0) throw new Error('At least one reviewer model is required');
  if (deduped.length > 6) throw new Error('At most six reviewer models are supported');
  return deduped;
}

function normalizeModelSpec(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty model spec');

  const { base: providerModel, thinkingLevel } = splitThinkingLevel(trimmed);
  const slashIndex = providerModel.indexOf('/');
  if (slashIndex <= 0 || slashIndex === providerModel.length - 1) {
    throw new Error(`Model spec must be provider/model[:thinking], got ${input}`);
  }

  const provider = providerModel.slice(0, slashIndex);
  const modelId = providerModel.slice(slashIndex + 1);
  const spec = `${provider}/${modelId}${thinkingLevel ? `:${thinkingLevel}` : ''}`;
  return { provider, modelId, thinkingLevel, spec };
}

function splitThinkingLevel(spec) {
  const colonIndex = spec.lastIndexOf(':');
  if (colonIndex === -1) return { base: spec, thinkingLevel: undefined };
  const possibleLevel = spec.slice(colonIndex + 1).toLowerCase();
  const normalizedLevel = THINKING_LEVEL_ALIASES.get(possibleLevel);
  if (!normalizedLevel) return { base: spec, thinkingLevel: undefined };
  return { base: spec.slice(0, colonIndex), thinkingLevel: normalizedLevel };
}

async function collectEvidence(options) {
  const sections = [];
  sections.push(`CWD: ${options.cwd}`);
  if (options.paths.length > 0)
    sections.push(`Focus paths:\n${options.paths.map((p) => `- ${p}`).join('\n')}`);

  const shouldReadStdin = options.readStdin ?? !process.stdin.isTTY;
  if (shouldReadStdin) {
    const stdin = await readStdinIfAvailable();
    if (stdin.trim())
      sections.push(formatSection('Additional stdin material', stdin, options.maxDiffBytes));
  }

  const gitEvidence = await collectGitEvidence(options);
  if (gitEvidence) sections.push(gitEvidence);

  return redactSensitiveText(sections.join('\n\n'));
}

async function readStdinIfAvailable() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function collectGitEvidence(options) {
  const inside = await runGit(options.cwd, ['rev-parse', '--is-inside-work-tree'], 10_000);
  if (!inside.ok || inside.stdout.trim() !== 'true')
    return 'Git: not inside a git work tree, or git unavailable.';

  const pathArgs = options.paths.length > 0 ? ['--', ...options.paths] : [];
  const sections = [];
  const status = await runGit(
    options.cwd,
    ['status', '--short', ...pathArgs],
    options.maxDiffBytes,
  );
  sections.push(formatCommandResult('git status --short', status, options.maxDiffBytes));

  if (options.collectDiff) {
    if (!options.stagedOnly) {
      const unstaged = await runGit(
        options.cwd,
        ['diff', '--no-ext-diff', '--find-renames', '--find-copies', ...pathArgs],
        options.maxDiffBytes,
      );
      sections.push(formatCommandResult('git diff --no-ext-diff', unstaged, options.maxDiffBytes));
    }
    const staged = await runGit(
      options.cwd,
      ['diff', '--cached', '--no-ext-diff', '--find-renames', '--find-copies', ...pathArgs],
      options.maxDiffBytes,
    );
    sections.push(
      formatCommandResult('git diff --cached --no-ext-diff', staged, options.maxDiffBytes),
    );
  }

  return sections.join('\n\n');
}

async function runGit(cwd, args, maxBytes) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: Math.max(maxBytes * 4, 1_000_000),
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message,
    };
  }
}

function formatCommandResult(label, result, maxBytes) {
  const body = [result.stdout, result.stderr ? `STDERR:\n${result.stderr}` : '']
    .filter(Boolean)
    .join('\n');
  const text = body.trim() || '(no output)';
  const status = result.ok ? '' : ' (command failed)';
  return formatSection(`${label}${status}`, text, maxBytes);
}

function formatSection(title, text, maxBytes) {
  return `## ${title}\n\n${truncateText(text, maxBytes)}`;
}

function truncateText(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n\n[truncated ${buf.length - maxBytes} bytes]`;
}

function redactSensitiveText(text) {
  return text
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*([^\s'"`]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED_AWS_ACCESS_KEY]');
}

function buildSharedBrief(options, evidence) {
  const userRequest =
    options.requestParts.join(' ').trim() || 'Review the current repository changes.';
  return `# Shared Roundtable Review Brief

## User request

${userRequest}

## Review target and evidence

${evidence}

## Constraints

- Review only; do not modify project/source files.
- Work independently; do not assume consensus with other reviewers.
- Prioritize concrete, evidence-backed findings over style preferences.
- If evidence is insufficient, say what evidence is missing rather than inventing findings.
- Focus on blockers, correctness risks, security/privacy issues, regression risk, and test gaps.
- Return exactly these sections:
  - ## Summary
  - ## Key observations
  - ## Recommendation
  - ## Tradeoffs and risks
`;
}

function buildReviewerPrompt(sharedBrief, modelSpec) {
  return `${sharedBrief}

You are the ${modelSpec} roundtable reviewer. Use available read-only tools if needed. Review independently and do not modify files.`;
}

function buildSynthesisPrompt({ sharedBrief, reviewerResults }) {
  const successful = reviewerResults.filter((result) => result.ok);
  const failed = reviewerResults.filter((result) => !result.ok);

  return `# Roundtable Review Synthesis Task

Synthesize the independent reviewer outputs below. Do not average opinions blindly: prioritize evidence-backed findings, call out disagreements, and decide what is actionable now.

Return exactly this Markdown structure:

# Roundtable Review

## Reviewers Used
- model ids actually used

## Consensus
- where reviewers agree

## Disagreements
- important differences in assumptions, evidence, or recommendations

## Recommendation
- synthesized next move, with rationale

## Actionable Findings
- blockers/fixes worth doing now, with file/line evidence when available

## Per-Model Notes
- 1-2 sentence takeaway per reviewer

## Shared brief

${sharedBrief}

## Successful reviewer outputs

${successful.map((result) => `### ${result.modelSpec}\n\n${result.text}`).join('\n\n')}

## Failed reviewers

${failed.length === 0 ? '(none)' : failed.map((result) => `- ${result.modelSpec}: ${result.error}`).join('\n')}
`;
}

function createRunTelemetry({ kind, modelSpec, timeoutMs }) {
  return {
    kind,
    modelSpec,
    timeoutMs,
    createdAt: Date.now(),
    startedAt: undefined,
    endedAt: undefined,
    status: 'pending',
    lastEvent: 'pending',
    lastActivityAt: undefined,
    turnCount: 0,
    textChars: 0,
    thinkingChars: 0,
    toolCallChars: 0,
    modelToolCalls: 0,
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    toolCallsFailed: 0,
    activeTools: new Map(),
    retrying: false,
    retryAttempt: 0,
    maxRetryAttempts: undefined,
    retryDelayMs: undefined,
    retryCount: 0,
    retryFailures: 0,
    lastRetryError: undefined,
    compaction: undefined,
    stopReason: undefined,
    usage: undefined,
    errorMessage: undefined,
  };
}

function createStatusReporter(options, reviewerTelemetries) {
  const startedAt = Date.now();
  let timer;
  let started = false;
  let stopped = false;
  const state = {
    phase: 'starting',
    reviewerTelemetries,
    synthesisTelemetry: undefined,
    synthesisStatus: 'pending',
  };

  // Terminal sessions never change again, so emit their full line once (when
  // first observed terminal) and suppress it from later periodic frames; they
  // remain summarized in the header counts. The final frame prints everything.
  const printedTerminalLine = new Set();
  const renderSessionLine = (telemetry, now, isFinal) => {
    if (!isFinal && isTerminalTelemetryStatus(telemetry.status)) {
      if (printedTerminalLine.has(telemetry)) return undefined;
      printedTerminalLine.add(telemetry);
    }
    return `[roundtable-review]   ${formatTelemetryLine(telemetry, now)}`;
  };

  const emit = (reason = 'status') => {
    if (!options.statusEnabled || stopped) return;
    const now = Date.now();
    const isFinal = reason === 'done';
    const counts = countTelemetryStatuses(reviewerTelemetries);
    const synthesisStatus = state.synthesisTelemetry?.status ?? state.synthesisStatus;
    const running = (counts.starting ?? 0) + (counts.running ?? 0);
    const failed = (counts.failed ?? 0) + (counts['timed-out'] ?? 0);
    const lines = [
      `[roundtable-review] ${reason} elapsed=${formatDuration(now - startedAt)} phase=${state.phase} reviewers=${counts.done ?? 0}/${reviewerTelemetries.length} done, ${failed} failed, ${running} running synthesis=${synthesisStatus}`,
    ];

    for (const telemetry of reviewerTelemetries) {
      const line = renderSessionLine(telemetry, now, isFinal);
      if (line) lines.push(line);
    }
    if (state.synthesisTelemetry) {
      const line = renderSessionLine(state.synthesisTelemetry, now, isFinal);
      if (line) lines.push(line);
    }

    process.stderr.write(`${lines.join('\n')}\n`);
  };

  return {
    state,
    start() {
      if (!options.statusEnabled) return;
      started = true;
      emit('start');
      timer = setInterval(() => emit('status'), options.statusIntervalMs);
      timer.unref?.();
    },
    emit,
    stop(reason = 'done') {
      if (stopped) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (started) emit(reason);
      stopped = true;
    },
  };
}

function countTelemetryStatuses(telemetries) {
  const counts = {};
  for (const telemetry of telemetries) {
    counts[telemetry.status] = (counts[telemetry.status] ?? 0) + 1;
  }
  return counts;
}

function handleTelemetryEvent(telemetry, event) {
  if (!telemetry) return;
  try {
    updateTelemetryFromEvent(telemetry, event);
  } catch {
    // Telemetry must never affect the review run.
  }
}

function updateTelemetryFromEvent(telemetry, event) {
  const now = Date.now();
  const eventName = event.type === 'message_update' ? event.assistantMessageEvent.type : event.type;
  recordTelemetryActivity(telemetry, eventName, now);

  switch (event.type) {
    case 'agent_start':
      markTelemetryRunning(telemetry, now);
      break;
    case 'turn_start':
      telemetry.turnCount += 1;
      break;
    case 'message_update':
      updateTelemetryFromAssistantMessageEvent(telemetry, event.assistantMessageEvent);
      break;
    case 'message_end':
      captureUsageFromAssistantMessage(telemetry, event.message);
      break;
    case 'agent_end':
      if (event.willRetry) telemetry.retrying = true;
      break;
    case 'tool_execution_start':
      telemetry.toolCallsStarted += 1;
      telemetry.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: now });
      break;
    case 'tool_execution_end':
      telemetry.toolCallsCompleted += 1;
      if (event.isError) telemetry.toolCallsFailed += 1;
      telemetry.activeTools.delete(event.toolCallId);
      break;
    case 'compaction_start':
      telemetry.compaction = `${event.reason}:running`;
      break;
    case 'compaction_end':
      telemetry.compaction = `${event.reason}:${event.aborted ? 'aborted' : 'done'}`;
      break;
    case 'auto_retry_start':
      telemetry.retrying = true;
      telemetry.retryAttempt = event.attempt;
      telemetry.maxRetryAttempts = event.maxAttempts;
      telemetry.retryDelayMs = event.delayMs;
      telemetry.retryCount = Math.max(telemetry.retryCount, event.attempt);
      telemetry.lastRetryError = event.errorMessage;
      break;
    case 'auto_retry_end':
      telemetry.retrying = false;
      telemetry.retryDelayMs = undefined;
      if (!event.success) telemetry.retryFailures += 1;
      if (event.finalError) telemetry.lastRetryError = event.finalError;
      break;
  }
}

function updateTelemetryFromAssistantMessageEvent(telemetry, event) {
  switch (event.type) {
    case 'text_delta':
      telemetry.textChars += event.delta.length;
      break;
    case 'thinking_delta':
      telemetry.thinkingChars += event.delta.length;
      break;
    case 'toolcall_delta':
      telemetry.toolCallChars += event.delta.length;
      break;
    case 'toolcall_end':
      telemetry.modelToolCalls += 1;
      break;
    case 'done':
      telemetry.stopReason = event.reason;
      captureUsageFromAssistantMessage(telemetry, event.message);
      break;
    case 'error':
      telemetry.stopReason = event.reason;
      telemetry.errorMessage = event.error.errorMessage;
      captureUsageFromAssistantMessage(telemetry, event.error);
      break;
  }
}

function recordTelemetryActivity(telemetry, eventName, now = Date.now()) {
  telemetry.lastEvent = eventName;
  telemetry.lastActivityAt = now;
}

function markTelemetryStarting(telemetry) {
  if (!telemetry) return;
  const now = Date.now();
  telemetry.startedAt ??= now;
  if (!isTerminalTelemetryStatus(telemetry.status)) telemetry.status = 'starting';
  recordTelemetryActivity(telemetry, 'session_setup', now);
}

function markTelemetryRunning(telemetry, now = Date.now()) {
  if (!telemetry) return;
  telemetry.startedAt ??= now;
  if (!isTerminalTelemetryStatus(telemetry.status)) telemetry.status = 'running';
}

function markTelemetryEnded(telemetry, status, errorMessage) {
  if (!telemetry) return;
  telemetry.status = status;
  telemetry.endedAt = Date.now();
  if (errorMessage) telemetry.errorMessage = errorMessage;
}

function isTerminalTelemetryStatus(status) {
  return status === 'done' || status === 'failed' || status === 'timed-out' || status === 'skipped';
}

function finalizeTelemetryFromSession(telemetry, session) {
  if (!telemetry || !session) return;
  const message = getLastAssistantMessage(session.messages);
  if (message) captureUsageFromAssistantMessage(telemetry, message);
}

function captureUsageFromAssistantMessage(telemetry, message) {
  if (!message || message.role !== 'assistant') return;
  telemetry.stopReason = message.stopReason ?? telemetry.stopReason;
  telemetry.usage = message.usage ?? telemetry.usage;
  if (message.errorMessage) telemetry.errorMessage = message.errorMessage;
}

function appendTelemetryDiagnostic(message, telemetry) {
  const diagnostic = formatTelemetryDiagnostic(telemetry);
  return diagnostic ? `${message}; ${diagnostic}` : message;
}

function formatTelemetryDiagnostic(telemetry) {
  if (!telemetry) return '';
  const now = Date.now();
  const parts = [];
  if (telemetry.lastActivityAt) {
    parts.push(`last=${telemetry.lastEvent} ${formatDuration(now - telemetry.lastActivityAt)} ago`);
  } else {
    parts.push(`last=${telemetry.lastEvent}`);
  }
  parts.push(`turns=${telemetry.turnCount}`);
  parts.push(`thinking=${formatChars(telemetry.thinkingChars)}`);
  parts.push(`text=${formatChars(telemetry.textChars)}`);
  parts.push(formatToolSummary(telemetry));
  if (telemetry.retryCount > 0 || telemetry.retrying) parts.push(formatRetrySummary(telemetry));
  if (telemetry.stopReason) parts.push(`stop=${telemetry.stopReason}`);
  if (telemetry.usage) parts.push(formatUsage(telemetry.usage));
  return parts.filter(Boolean).join(', ');
}

function formatTelemetryLine(telemetry, now = Date.now()) {
  const parts = [telemetry.kind, telemetry.modelSpec, telemetry.status];
  const elapsedBase = telemetry.startedAt ?? telemetry.createdAt;
  const elapsedLabel = telemetry.startedAt ? 'elapsed' : 'pendingFor';
  parts.push(`${elapsedLabel}=${formatDuration((telemetry.endedAt ?? now) - elapsedBase)}`);
  if (telemetry.timeoutMs && telemetry.startedAt && !isTerminalTelemetryStatus(telemetry.status)) {
    parts.push(
      `timeoutIn=${formatDuration(Math.max(0, telemetry.timeoutMs - (now - telemetry.startedAt)))}`,
    );
  }
  parts.push(`turn=${telemetry.turnCount}`);
  if (telemetry.lastActivityAt) {
    parts.push(`last=${telemetry.lastEvent} ${formatDuration(now - telemetry.lastActivityAt)} ago`);
  } else {
    parts.push(`last=${telemetry.lastEvent}`);
  }
  parts.push(`thinking=${formatChars(telemetry.thinkingChars)}`);
  parts.push(`text=${formatChars(telemetry.textChars)}`);
  if (telemetry.modelToolCalls > 0 || telemetry.toolCallChars > 0) {
    parts.push(`modelToolCalls=${telemetry.modelToolCalls}`);
  }
  parts.push(formatToolSummary(telemetry));

  const activeTools = [...new Set([...telemetry.activeTools.values()].map((tool) => tool.name))];
  if (activeTools.length > 0) parts.push(`activeTool=${activeTools.join(',')}`);
  if (telemetry.retryCount > 0 || telemetry.retrying) parts.push(formatRetrySummary(telemetry));
  if (telemetry.compaction) parts.push(`compaction=${telemetry.compaction}`);
  if (telemetry.stopReason) parts.push(`stop=${telemetry.stopReason}`);
  if (telemetry.usage && isTerminalTelemetryStatus(telemetry.status)) {
    parts.push(formatUsage(telemetry.usage));
  }
  return parts.filter(Boolean).join(' ');
}

function formatToolSummary(telemetry) {
  if (telemetry.toolCallsStarted === 0) return 'tools=0';
  const parts = [`tools=${telemetry.toolCallsCompleted}/${telemetry.toolCallsStarted} done`];
  if (telemetry.toolCallsFailed > 0) parts.push(`${telemetry.toolCallsFailed} failed`);
  return parts.join('/');
}

function formatRetrySummary(telemetry) {
  if (telemetry.retrying) {
    const max = telemetry.maxRetryAttempts ?? '?';
    const delay = telemetry.retryDelayMs ? ` next=${formatDuration(telemetry.retryDelayMs)}` : '';
    return `retry=${telemetry.retryAttempt}/${max}${delay}`;
  }
  const failures = telemetry.retryFailures > 0 ? `/${telemetry.retryFailures} failed` : '';
  return `retries=${telemetry.retryCount}${failures}`;
}

function formatUsage(usage) {
  const total =
    usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return `tokens=${formatCount(total)} in=${formatCount(usage.input)} out=${formatCount(usage.output)}`;
}

function formatChars(value) {
  return `${formatCount(value)}ch`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return `${value}`;
}

function trimFixed(value) {
  return value.toFixed(1).replace(/\.0$/, '');
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(remainingSeconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${String(remainingMinutes).padStart(2, '0')}m`;
}

async function createSessionRunner({
  cwd,
  modelSpec,
  tools,
  approve,
  loadExtensions,
  loadSkills,
  noTools,
  verbose = false,
}) {
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    createAgentSession,
    getAgentDir,
  } = await loadPiCodingAgentSdk();

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resolved = resolveModel(modelRegistry, modelSpec);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: approve });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: !loadExtensions,
    noSkills: !loadSkills,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => approve });

  if (verbose) {
    const extensionsResult = resourceLoader.getExtensions();
    const skillsResult = resourceLoader.getSkills();
    console.error(
      `[roundtable-review] resources for ${resolved.spec}: extensions=${extensionsResult.extensions.length}, skills=${skillsResult.skills.length}`,
    );
    for (const { path, error } of extensionsResult.errors) {
      console.error(`[roundtable-review] extension load error: ${path}: ${error}`);
    }
    for (const diagnostic of skillsResult.diagnostics) {
      if (diagnostic.type === 'error') {
        const path = diagnostic.path ? `${diagnostic.path}: ` : '';
        console.error(`[roundtable-review] skill load error: ${path}${diagnostic.message}`);
      }
    }
  }

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    tools,
    noTools,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });

  return { session, resolved };
}

async function loadPiCodingAgentSdk() {
  piCodingAgentSdkPromise ??= importPiCodingAgentSdk();
  return piCodingAgentSdkPromise;
}

async function importPiCodingAgentSdk() {
  try {
    return await import('@earendil-works/pi-coding-agent');
  } catch (localImportError) {
    const activePiSdkPath = await findActivePiSdkPath();
    if (activePiSdkPath) {
      try {
        return await import(pathToFileURL(activePiSdkPath).href);
      } catch (activePiImportError) {
        throw new Error(
          `Could not import Pi SDK from local dependencies or active pi install.\n` +
            `Local import error: ${localImportError.message}\n` +
            `Active pi SDK path: ${activePiSdkPath}\n` +
            `Active pi import error: ${activePiImportError.message}`,
        );
      }
    }

    throw new Error(
      `Could not import @earendil-works/pi-coding-agent. Install this repo's dependencies or ensure the pi CLI is on PATH.\n` +
        `Import error: ${localImportError.message}`,
    );
  }
}

async function findActivePiSdkPath() {
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', 'command -v pi'], {
      maxBuffer: 64 * 1024,
    });
    const piPath = stdout.trim();
    if (!piPath) return undefined;

    const { stdout: resolvedStdout } = await execFileAsync(
      process.execPath,
      ['-e', "const fs=require('fs'); console.log(fs.realpathSync(process.argv[1]))", piPath],
      { maxBuffer: 64 * 1024 },
    );
    const resolvedPiPath = resolvedStdout.trim();

    if (resolvedPiPath.endsWith('/dist/cli.js')) {
      return resolve(dirname(resolvedPiPath), 'index.js');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveModel(modelRegistry, modelSpec) {
  const normalized = normalizeModelSpec(modelSpec);
  const model = modelRegistry.find(normalized.provider, normalized.modelId);
  if (!model) throw new Error(`Model not found: ${normalized.provider}/${normalized.modelId}`);
  return { ...normalized, model };
}

async function validateModelSpecs(modelSpecs) {
  const { AuthStorage, ModelRegistry } = await loadPiCodingAgentSdk();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const errors = [];

  for (const modelSpec of new Set(modelSpecs)) {
    try {
      resolveModel(modelRegistry, modelSpec);
    } catch (error) {
      const spec = String(modelSpec);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${spec}: ${message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Model preflight failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
}

async function runReviewer({
  cwd,
  modelSpec,
  sharedBrief,
  timeoutMs,
  approve,
  loadExtensions,
  loadSkills,
  verbose,
  telemetry,
}) {
  const startedAt = Date.now();
  let session;
  let unsubscribe;
  try {
    markTelemetryStarting(telemetry);
    if (verbose) console.error(`[roundtable-review] reviewer start: ${modelSpec}`);
    const runner = await createSessionRunner({
      cwd,
      modelSpec,
      tools: READ_ONLY_TOOLS,
      approve,
      loadExtensions,
      loadSkills,
      verbose,
    });
    session = runner.session;
    if (telemetry) telemetry.modelSpec = runner.resolved.spec;
    unsubscribe = session.subscribe((event) => handleTelemetryEvent(telemetry, event));
    await promptWithTimeout(
      session,
      buildReviewerPrompt(sharedBrief, runner.resolved.spec),
      timeoutMs,
      `reviewer ${runner.resolved.spec}`,
      telemetry,
    );
    finalizeTelemetryFromSession(telemetry, session);
    const text = getLastAssistantText(session.messages);
    if (!text.trim()) throw noAssistantTextError('Reviewer', session);
    markTelemetryEnded(telemetry, 'done');
    if (verbose) console.error(`[roundtable-review] reviewer done: ${runner.resolved.spec}`);
    return {
      ok: true,
      modelSpec: runner.resolved.spec,
      text,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    finalizeTelemetryFromSession(telemetry, session);
    const status = error.message.includes('timed out') ? 'timed-out' : 'failed';
    markTelemetryEnded(telemetry, status, error.message);
    const errorMessage = appendTelemetryDiagnostic(error.message, telemetry);
    if (verbose)
      console.error(`[roundtable-review] reviewer failed: ${modelSpec}: ${errorMessage}`);
    return {
      ok: false,
      modelSpec,
      error: errorMessage,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
  }
}

async function runSynthesis({
  cwd,
  synthModel,
  sharedBrief,
  reviewerResults,
  timeoutMs,
  approve,
  loadExtensions,
  loadSkills,
  verbose,
  telemetry,
}) {
  let session;
  let unsubscribe;
  try {
    markTelemetryStarting(telemetry);
    if (verbose) console.error(`[roundtable-review] synthesis start: ${synthModel}`);
    const runner = await createSessionRunner({
      cwd,
      modelSpec: synthModel,
      tools: [],
      approve,
      loadExtensions,
      loadSkills,
      noTools: 'all',
      verbose,
    });
    session = runner.session;
    if (telemetry) telemetry.modelSpec = runner.resolved.spec;
    unsubscribe = session.subscribe((event) => handleTelemetryEvent(telemetry, event));
    await promptWithTimeout(
      session,
      buildSynthesisPrompt({ sharedBrief, reviewerResults }),
      timeoutMs,
      `synthesis ${runner.resolved.spec}`,
      telemetry,
    );
    finalizeTelemetryFromSession(telemetry, session);
    const text = getLastAssistantText(session.messages);
    if (!text.trim()) throw noAssistantTextError('Synthesis', session);
    markTelemetryEnded(telemetry, 'done');
    if (verbose) console.error(`[roundtable-review] synthesis done: ${runner.resolved.spec}`);
    return { ok: true, modelSpec: runner.resolved.spec, text };
  } catch (error) {
    finalizeTelemetryFromSession(telemetry, session);
    const status = error.message.includes('timed out') ? 'timed-out' : 'failed';
    markTelemetryEnded(telemetry, status, error.message);
    return {
      ok: false,
      modelSpec: synthModel,
      error: appendTelemetryDiagnostic(error.message, telemetry),
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
  }
}

async function promptWithTimeout(session, prompt, timeoutMs, label, telemetry) {
  let timedOut = false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      markTelemetryEnded(telemetry, 'timed-out', `${label} timed out after ${timeoutMs}ms`);
      void session.abort().catch(() => {});
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([session.prompt(prompt), timeout]);
  } finally {
    clearTimeout(timeoutId);
    if (timedOut) await session.abort().catch(() => {});
  }
}

function getLastAssistantText(messages) {
  const message = getLastAssistantMessage(messages);
  if (!message) return '';
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function noAssistantTextError(kind, session) {
  const message = getLastAssistantMessage(session?.messages ?? []);
  if (message?.errorMessage) return new Error(`${kind} failed: ${message.errorMessage}`);
  if (message?.stopReason === 'error') {
    return new Error(`${kind} ended with a provider error and no assistant text`);
  }
  return new Error(`${kind} produced no assistant text`);
}

function getLastAssistantMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    return message;
  }
  return undefined;
}

function fallbackSynthesis(reviewerResults) {
  const successful = reviewerResults.filter((result) => result.ok);
  const failed = reviewerResults.filter((result) => !result.ok);
  return `# Roundtable Review

## Reviewers Used
${successful.length === 0 ? '- none' : successful.map((result) => `- ${result.modelSpec}`).join('\n')}

## Consensus
- Synthesis model failed or was unavailable; inspect per-model notes manually.

## Disagreements
- Not synthesized automatically.

## Recommendation
- Re-run synthesis or inspect the reviewer outputs below.

## Actionable Findings
- Not synthesized automatically.

## Per-Model Notes
${successful.map((result) => `### ${result.modelSpec}\n\n${result.text}`).join('\n\n') || '- No successful reviewer outputs.'}

## Failed Reviewers
${failed.length === 0 ? '- none' : failed.map((result) => `- ${result.modelSpec}: ${result.error}`).join('\n')}
`;
}

async function writeOutputIfRequested(path, content) {
  if (!path) return;
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const reviewerTelemetries = options.models.map((modelSpec) =>
    createRunTelemetry({ kind: 'reviewer', modelSpec, timeoutMs: options.reviewerTimeoutMs }),
  );
  const telemetryByModel = new Map(
    reviewerTelemetries.map((telemetry) => [telemetry.modelSpec, telemetry]),
  );
  const reporter = createStatusReporter(options, reviewerTelemetries);
  let completed = false;

  try {
    await validateModelSpecs([...options.models, options.synthModel]);

    reporter.state.phase = 'collecting-evidence';
    reporter.start();

    const evidence = await collectEvidence(options);
    const sharedBrief = buildSharedBrief(options, evidence);
    if (options.verbose) {
      console.error(`[roundtable-review] cwd: ${options.cwd}`);
      console.error(`[roundtable-review] reviewers: ${options.models.join(', ')}`);
      console.error(
        `[roundtable-review] pi resources: extensions=${options.loadExtensions ? 'enabled' : 'disabled'}, skills=${options.loadSkills ? 'enabled' : 'disabled'}, project-local=${options.approve ? 'trusted' : 'untrusted'}`,
      );
    }

    reporter.state.phase = 'reviewing';
    const reviewerPromises = options.models.map((modelSpec) =>
      runReviewer({
        cwd: options.cwd,
        modelSpec,
        sharedBrief,
        timeoutMs: options.reviewerTimeoutMs,
        approve: options.approve,
        loadExtensions: options.loadExtensions,
        loadSkills: options.loadSkills,
        verbose: options.verbose,
        telemetry: telemetryByModel.get(modelSpec),
      }),
    );
    reporter.emit('reviewers-start');
    const reviewerResults = await Promise.all(reviewerPromises);

    const successful = reviewerResults.filter((result) => result.ok);
    let synthesis;
    if (successful.length === 0) {
      reporter.state.synthesisStatus = 'skipped';
      synthesis = { ok: false, modelSpec: options.synthModel, error: 'No reviewers succeeded' };
    } else {
      const synthesisTelemetry = createRunTelemetry({
        kind: 'synthesis',
        modelSpec: options.synthModel,
        timeoutMs: options.synthesisTimeoutMs,
      });
      reporter.state.synthesisTelemetry = synthesisTelemetry;
      reporter.state.phase = 'synthesizing';
      const synthesisPromise = runSynthesis({
        cwd: options.cwd,
        synthModel: options.synthModel,
        sharedBrief,
        reviewerResults,
        timeoutMs: options.synthesisTimeoutMs,
        approve: options.approve,
        loadExtensions: options.loadExtensions,
        loadSkills: options.loadSkills,
        verbose: options.verbose,
        telemetry: synthesisTelemetry,
      });
      reporter.emit('synthesis-start');
      synthesis = await synthesisPromise;
    }

    reporter.state.phase = 'writing-output';
    const markdown = synthesis.ok ? synthesis.text : fallbackSynthesis(reviewerResults);
    const payload = {
      cwd: options.cwd,
      models: options.models,
      synthesisModel: synthesis.modelSpec,
      reviewerResults,
      synthesis,
      markdown,
    };

    const output =
      options.format === 'json' ? `${JSON.stringify(payload, null, 2)}\n` : `${markdown.trim()}\n`;
    await writeOutputIfRequested(options.output, output);
    process.stdout.write(output);

    reporter.state.phase = 'complete';
    completed = true;
    return successful.length === 0 ? 2 : 0;
  } finally {
    reporter.stop(completed ? 'done' : 'stopped');
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`roundtable-review: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
  },
);
