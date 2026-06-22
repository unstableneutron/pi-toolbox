#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let piCodingAgentSdkPromise;

const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const DEFAULT_REVIEWER_MODELS = [
  'openai/gpt-5.5:high',
  'anthropic/claude-opus-4-7:high',
  'google/gemini-3.1-pro-preview:high',
];
const DEFAULT_SYNTHESIS_MODEL = 'openai/gpt-5.5:high';
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

const MODEL_ALIASES = new Map([
  ['codex', 'openai-codex/gpt-5.5'],
  ['gpt', 'openai/gpt-5.5'],
  ['55', 'openai/gpt-5.5'],
  ['mini', 'openai/gpt-5.4-mini'],
  ['nano', 'openai/gpt-5.4-nano'],
  ['haiku', 'anthropic/claude-haiku-4-5'],
  ['sonnet', 'anthropic/claude-sonnet-4-6'],
  ['opus', 'anthropic/claude-opus-4-8'],
  ['gemini', 'google/gemini-3.1-pro-preview'],
  ['pro', 'google/gemini-3.1-pro-preview'],
  ['flash', 'google/gemini-3.5-flash'],
  ['flash-lite', 'google/gemini-3.1-flash-lite-preview'],
  ['lite', 'google/gemini-3.1-flash-lite-preview'],
]);

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
  --max-diff-bytes <bytes>    Max bytes per collected diff section (default: 180000)
  --approve                   Trust project-local resources for this SDK run
  --verbose                   Print progress to stderr
  -h, --help                  Show this help

Model specs use provider/model[:thinking], for example:
  openai/gpt-5.5:high, anthropic/claude-opus-4-7:high, gemini:high
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
    maxDiffBytes: 180_000,
    approve: false,
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
      case '--max-diff-bytes':
        options.maxDiffBytes = parsePositiveInteger(readValue(arg), arg);
        break;
      case '--approve':
        options.approve = true;
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

  const { base, thinkingLevel } = splitThinkingLevel(trimmed);
  const aliasTarget = MODEL_ALIASES.get(base) ?? base;
  const aliasSplit = splitThinkingLevel(aliasTarget);
  const effectiveThinkingLevel = thinkingLevel ?? aliasSplit.thinkingLevel;
  const providerModel = aliasSplit.base;
  const slashIndex = providerModel.indexOf('/');
  if (slashIndex <= 0 || slashIndex === providerModel.length - 1) {
    throw new Error(`Model spec must be provider/model[:thinking], got ${input}`);
  }

  const provider = providerModel.slice(0, slashIndex);
  const modelId = providerModel.slice(slashIndex + 1);
  const spec = `${provider}/${modelId}${effectiveThinkingLevel ? `:${effectiveThinkingLevel}` : ''}`;
  return { provider, modelId, thinkingLevel: effectiveThinkingLevel, spec };
}

function splitThinkingLevel(spec) {
  const colonIndex = spec.lastIndexOf(':');
  if (colonIndex === -1) return { base: spec, thinkingLevel: undefined };
  const possibleLevel = spec.slice(colonIndex + 1);
  if (!VALID_THINKING_LEVELS.has(possibleLevel)) return { base: spec, thinkingLevel: undefined };
  return { base: spec.slice(0, colonIndex), thinkingLevel: possibleLevel };
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

async function createSessionRunner({ cwd, modelSpec, tools, approve, noTools = undefined }) {
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
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => approve });

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

async function runReviewer({ cwd, modelSpec, sharedBrief, timeoutMs, approve, verbose }) {
  const startedAt = Date.now();
  let session;
  try {
    if (verbose) console.error(`[roundtable-review] reviewer start: ${modelSpec}`);
    const runner = await createSessionRunner({
      cwd,
      modelSpec,
      tools: READ_ONLY_TOOLS,
      approve,
    });
    session = runner.session;
    await promptWithTimeout(
      session,
      buildReviewerPrompt(sharedBrief, runner.resolved.spec),
      timeoutMs,
      `reviewer ${runner.resolved.spec}`,
    );
    const text = getLastAssistantText(session.messages);
    if (!text.trim()) throw new Error('Reviewer produced no assistant text');
    if (verbose) console.error(`[roundtable-review] reviewer done: ${runner.resolved.spec}`);
    return {
      ok: true,
      modelSpec: runner.resolved.spec,
      text,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (verbose)
      console.error(`[roundtable-review] reviewer failed: ${modelSpec}: ${error.message}`);
    return {
      ok: false,
      modelSpec,
      error: error.message,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
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
  verbose,
}) {
  let session;
  try {
    if (verbose) console.error(`[roundtable-review] synthesis start: ${synthModel}`);
    const runner = await createSessionRunner({
      cwd,
      modelSpec: synthModel,
      tools: [],
      approve,
      noTools: 'all',
    });
    session = runner.session;
    await promptWithTimeout(
      session,
      buildSynthesisPrompt({ sharedBrief, reviewerResults }),
      timeoutMs,
      `synthesis ${runner.resolved.spec}`,
    );
    const text = getLastAssistantText(session.messages);
    if (!text.trim()) throw new Error('Synthesis produced no assistant text');
    if (verbose) console.error(`[roundtable-review] synthesis done: ${runner.resolved.spec}`);
    return { ok: true, modelSpec: runner.resolved.spec, text };
  } catch (error) {
    return { ok: false, modelSpec: synthModel, error: error.message };
  } finally {
    session?.dispose();
  }
}

async function promptWithTimeout(session, prompt, timeoutMs, label) {
  let timedOut = false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
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

  const evidence = await collectEvidence(options);
  const sharedBrief = buildSharedBrief(options, evidence);
  if (options.verbose) {
    console.error(`[roundtable-review] cwd: ${options.cwd}`);
    console.error(`[roundtable-review] reviewers: ${options.models.join(', ')}`);
  }

  const reviewerResults = await Promise.all(
    options.models.map((modelSpec) =>
      runReviewer({
        cwd: options.cwd,
        modelSpec,
        sharedBrief,
        timeoutMs: options.reviewerTimeoutMs,
        approve: options.approve,
        verbose: options.verbose,
      }),
    ),
  );

  const successful = reviewerResults.filter((result) => result.ok);
  let synthesis;
  if (successful.length === 0) {
    synthesis = { ok: false, modelSpec: options.synthModel, error: 'No reviewers succeeded' };
  } else {
    synthesis = await runSynthesis({
      cwd: options.cwd,
      synthModel: options.synthModel,
      sharedBrief,
      reviewerResults,
      timeoutMs: options.synthesisTimeoutMs,
      approve: options.approve,
      verbose: options.verbose,
    });
  }

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

  return successful.length === 0 ? 2 : 0;
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
