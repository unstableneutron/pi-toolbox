#!/usr/bin/env bun
/**
 * Extract bash-tool invocations from Pi agent session logs.
 *
 * Produces a deterministic, deduplicated JSONL corpus suitable for checking
 * in as a regression fixture for the bash-rewrite classifier, and
 * optionally a `--triage` report that highlights commands the classifier
 * does NOT yet rewrite — the raw material for adding new recognizers.
 *
 * Two input sources are supported:
 *
 *   --from pi-mono   Pull bash calls from the public
 *                    https://huggingface.co/datasets/badlogicgames/pi-mono
 *                    dataset. This is the canonical source for the
 *                    committed test-fixture corpus — no personal data.
 *
 *   --from local     Pull bash calls from the user's local Pi session
 *                    logs at ~/.pi/agent/sessions. Intended for the
 *                    personal, gitignored validation corpus and for
 *                    day-to-day triage of misses.
 *
 * Usage:
 *   # Refresh the public committed fixture:
 *   ./scripts/extract-bash-corpus.ts --from pi-mono \
 *     --out test-fixtures/bash-corpus.jsonl
 *
 *   # Build a local validation set AND a miss report for the last 3 days:
 *   ./scripts/extract-bash-corpus.ts --from local --days 3 \
 *     --out test-fixtures/bash-corpus.local.jsonl --triage
 *
 * Pipeline:
 *   1. Pull every toolCall where name == "bash".
 *   2. Drop empty, multi-line, and over-`--max-bytes` commands.
 *      (They always fail the classifier's fast-path gate, so they add
 *      no test signal and just bloat the corpus.)
 *   3. Run each command through SANITIZERS below as defense-in-depth.
 *   4. Deduplicate by exact string, sort deterministically.
 *   5. Write one `{"command": "..."}` object per line.
 *   6. If --triage, classify each command via tryRewriteBash, cluster
 *      the non-rewritten ones by first token + pipe-shape, write a
 *      markdown report next to the corpus file.
 *
 * Requires `bun` on PATH. Requires `duckdb` on PATH for --from pi-mono.
 * The HF dataset is auto-converted to a single Parquet shard, cached locally.
 */

import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tryRewriteBash } from '../bash-rewrite';

type Sanitizer = readonly [RegExp, string];

const SECRET_PATTERNS: Sanitizer[] = [
  [/ghp_[A-Za-z0-9]{20,}/g, '<REDACTED_GH_TOKEN>'],
  [/gh[sup]_[A-Za-z0-9]{20,}/g, '<REDACTED_GH_TOKEN>'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '<REDACTED_GH_TOKEN>'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '<REDACTED_API_KEY>'],
  [/sk-[A-Za-z0-9]{20,}/g, '<REDACTED_API_KEY>'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '<REDACTED_SLACK_TOKEN>'],
  [/AKIA[0-9A-Z]{16}/g, '<REDACTED_AWS_KEY>'],
  [/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED>'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED_JWT>'],
];

const PII_PATTERNS: Sanitizer[] = [
  // Email — allow backslash-escaped dots/chars so shell-regex forms like
  // `vince\.chang@airbnb\.com` get caught too.
  [/[A-Za-z0-9._%+\-\\]+@[A-Za-z0-9.\-\\]+\\?\.[A-Za-z]{2,}/g, '<REDACTED_EMAIL>'],
  // ssh user@IP — IPv4 only.
  [/\b[a-z_][a-z0-9_-]{2,}@(?:\d{1,3}\.){3}\d{1,3}\b/g, 'USER@HOST'],
  // Private IPv4 (10.x, 127.x, 172.16-31.x, 192.168.x).
  [
    /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g,
    '<PRIVATE_IP>',
  ],
  // Public IPv4 — catch-all after private redactions.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<PUBLIC_IP>'],
];

const PATH_PATTERNS: Sanitizer[] = [
  [/\/Users\/[A-Za-z0-9_.-]+/g, '/Users/USER'],
  [/\/home\/[A-Za-z0-9_.-]+/g, '/home/USER'],
  [/--Users-[A-Za-z0-9_.-]+/g, '--Users-USER'],
  [/--home-[A-Za-z0-9_.-]+/g, '--home-USER'],
  [/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]+Z_[0-9a-f-]+/g, '<SESSION_ID>'],
];

// Employer-internal project/service/host/codename names. Whole-word replacement.
const INTERNAL_NAMES = [
  'airlab',
  'airbnb-rewrite',
  'treehouse',
  'metagross',
  'aircover',
  'airchat',
  'skipper',
  'signalgateway',
  'clams',
  'scouter',
  'tempo',
  'braintrust',
  'spinnaker',
  'kendall',
  'nerf',
  'sitar',
  'airinspect',
  'slicer',
  'gandalf',
  'gandalf-lite',
  'himeji',
  'himejiconfigs',
  'oysterdispatcher',
  'oyster',
  'viaduct',
  'powergrid',
  'jitney',
  'spinaltap',
  'trebuchet',
  'ergo',
  'twig',
  'pineapple',
  'tools-loop',
  'hep',
];

const NAME_ALT = INTERNAL_NAMES.join('|');
const NAME_ALT_CAPS = INTERNAL_NAMES.map((n) => n[0]!.toUpperCase() + n.slice(1)).join('|');

const INTERNAL_PATTERNS: Sanitizer[] = [
  [/com[./]airbnb[./][A-Za-z0-9._/-]+/g, 'com/airbnb/<internal>'],
  [/(?<![A-Za-z0-9])airbnb-[A-Za-z0-9_-]+/g, 'airbnb-<internal>'],
  [/(?<![A-Za-z0-9])airbnb_[a-z0-9_]+/g, 'airbnb_<internal>'],
  [/\bairbnb\.toml\b/g, '<internal>.toml'],
  [new RegExp(`(?<![A-Za-z0-9])(?:${NAME_ALT})(?![A-Za-z0-9])`, 'gi'), '<internal>'],
  [new RegExp(`(?<![A-Za-z0-9])(?:${NAME_ALT_CAPS})(?=[A-Z]|[^A-Za-z]|$)`, 'g'), '<Internal>'],
  [new RegExp(`(?<=[a-z0-9])(?:${NAME_ALT_CAPS})(?=[A-Z]|[^A-Za-z]|$)`, 'g'), '<Internal>'],
  [/(?:[A-Za-z0-9_-]+\\?\.)*muscache\\?\.com/g, '<internal-host>'],
  [/(?:[A-Za-z0-9_-]+\\?\.)*musta\\?\.ch/g, '<internal-host>'],
  [
    /https?:\/\/(?:[A-Za-z0-9.-]+\.airbnb\.(?:com|tools))(?:\/[A-Za-z0-9._/\-?=&#%]*)?/g,
    'https://<internal-host>/<path>',
  ],
  [/(?:[A-Za-z0-9_-]+\.)+airbnb\.tools/g, '<internal-host>'],
  [/\bairbnb\.tools\b/g, '<internal-host>'],
  [/\b(?:analysis|core)\.[a-z][a-z0-9_.]+/g, '<internal-table>'],
  [
    /\b[A-Za-z0-9]*(?:HostEarningsProtection|HostEarnings|ClaimEntityTree|ClaimEvidence|ClaimItem|HostGuarantee|CheckoutQuote)[A-Za-z0-9]*/g,
    '<InternalProduct>',
  ],
  [/\b[0-9]{10,}\b/g, '<INTERNAL_ID>'],
  // Collapse consecutive <internal> placeholders.
  [/(?:<internal>[-_/])+<internal>/g, '<internal>'],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSanitizers(extraUsernames: string[]): Sanitizer[] {
  const userPatterns: Sanitizer[] = extraUsernames
    .filter((u) => u.length > 0)
    .map((u) => [new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(u)}(?![A-Za-z0-9])`, 'g'), 'USER']);
  return [
    ...userPatterns,
    ...SECRET_PATTERNS,
    ...PII_PATTERNS,
    ...PATH_PATTERNS,
    ...INTERNAL_PATTERNS,
  ];
}

function sanitize(cmd: string, sanitizers: Sanitizer[]): string {
  let out = cmd;
  for (const [pat, repl] of sanitizers) {
    out = out.replace(pat, repl);
  }
  return out;
}

// --- Extraction -------------------------------------------------------------

interface ToolCallContent {
  type?: unknown;
  name?: unknown;
  arguments?: { command?: unknown } | null;
  input?: { command?: unknown } | null;
}

function extractFromFile(filePath: string): string[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (obj as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as ToolCallContent;
      if (e.type !== 'toolCall' || e.name !== 'bash') continue;
      const args = e.arguments ?? e.input ?? {};
      const cmd = (args as { command?: unknown }).command;
      if (typeof cmd === 'string' && cmd.trim().length > 0) {
        found.push(cmd);
      }
    }
  }
  return found;
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    // Use plain readdir (names only) and stat per entry. The
    // `withFileTypes` overload is picking up a `Dirent<Buffer>` return
    // type under bun's `--strict` TS, which forces messy casts; the
    // extra stat calls are fine for the session-log volumes we walk
    // (~hundreds of files, not millions).
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(full);
      else if (st.isFile() && name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function pullFromLocal(args: {
  sessions: string;
  days: number;
  maxBytes: number;
  keepMultiline: boolean;
}): Promise<string[]> {
  const cutoff = Date.now() - args.days * 86_400_000;
  const files = await walkJsonlFiles(args.sessions);
  const raw: string[] = [];
  let scanned = 0;
  for (const f of files) {
    let mtime: number;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;
    scanned += 1;
    raw.push(...extractFromFile(f));
  }
  process.stderr.write(`scanned ${scanned} session files in ${args.sessions}\n`);
  return raw.filter(
    (cmd) => (args.keepMultiline || !cmd.includes('\n')) && cmd.length <= args.maxBytes,
  );
}

const PI_MONO_PARQUET_URL =
  'https://huggingface.co/api/datasets/badlogicgames/pi-mono/parquet/default/train/0.parquet';

async function pullFromPiMono(args: {
  cacheDir: string;
  maxBytes: number;
  keepMultiline: boolean;
}): Promise<string[]> {
  const duckdb = spawnSync('which', ['duckdb'], { encoding: 'utf8' });
  if (duckdb.status !== 0 || !duckdb.stdout.trim()) {
    process.stderr.write(
      'error: --from pi-mono requires `duckdb` on PATH (install via mise / brew).\n',
    );
    process.exit(1);
  }
  mkdirSync(args.cacheDir, { recursive: true });
  const parquetPath = path.join(args.cacheDir, 'pi-mono-0.parquet');
  if (!existsSync(parquetPath)) {
    process.stderr.write(`downloading pi-mono parquet → ${parquetPath}\n`);
    const res = await fetch(PI_MONO_PARQUET_URL);
    if (!res.ok) throw new Error(`failed to download pi-mono parquet: HTTP ${res.status}`);
    writeFileSync(parquetPath, Buffer.from(await res.arrayBuffer()));
  }
  const multilineFilter = args.keepMultiline ? '' : " AND command NOT LIKE '%' || chr(10) || '%'";
  const rawJsonl = path.join(args.cacheDir, 'pi-mono-raw.jsonl');
  const sql = `
COPY (
  WITH exploded AS (
    SELECT unnest(traces) AS t FROM read_parquet('${parquetPath}')
  ),
  messages AS (
    SELECT json_extract(t, '$.message.content') AS content FROM exploded
    WHERE json_extract_string(t, '$.type') = 'message'
      AND json_extract_string(t, '$.message.content') IS NOT NULL
  ),
  content_items AS (
    SELECT unnest(from_json(content, '["JSON"]')) AS item
    FROM messages WHERE content LIKE '[%'
  ),
  bash_raw AS (
    SELECT coalesce(
      json_extract_string(item, '$.arguments.command'),
      json_extract_string(item, '$.input.command')
    ) AS command
    FROM content_items
    WHERE json_extract_string(item, '$.type') = 'toolCall'
      AND json_extract_string(item, '$.name') = 'bash'
  )
  SELECT DISTINCT command FROM bash_raw
  WHERE command IS NOT NULL AND trim(command) <> ''
    AND length(command) <= ${args.maxBytes}${multilineFilter}
  ORDER BY command
) TO '${rawJsonl}' (FORMAT JSON);
`.trim();
  const run = spawnSync('duckdb', ['-c', sql], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`duckdb failed with exit code ${run.status}`);
  const raw: string[] = [];
  for (const line of readFileSync(rawJsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      raw.push(String((JSON.parse(line) as { command: unknown }).command));
    } catch {
      // ignore
    }
  }
  return raw;
}

// --- Triage -----------------------------------------------------------------

/**
 * Cheap shape signature for clustering non-rewritten commands. Format:
 *   `first-token[:pipeN][:redir][:subsh][:chain][:@second-token]`
 *
 * Deliberately coarse: the goal is to surface promising recognizer targets
 * ("oh, we're seeing `jq … | head` a lot"), not a perfect taxonomy. The
 * second-token tail disambiguates subcommands like `git log` vs `git diff`.
 */
function shapeSignature(cmd: string): string {
  const trimmed = cmd.trim();
  const firstToken = (/^\s*([A-Za-z_][A-Za-z0-9_-]*|\S+)/.exec(trimmed)?.[1] ?? '?').slice(0, 32);
  const stages = trimmed.split(/\|(?!\|)/).length;
  const hasRedirect = /[<>]/.test(trimmed);
  const hasSubshell = /\$\(|`/.test(trimmed);
  const hasChain = /&&|;|\|\|/.test(trimmed);
  const parts: string[] = [firstToken];
  if (stages > 1) parts.push(`pipe${stages}`);
  if (hasRedirect) parts.push('redir');
  if (hasSubshell) parts.push('subsh');
  if (hasChain) parts.push('chain');
  const rest = trimmed
    .slice(firstToken.length)
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
    .slice(0, 1);
  if (rest.length > 0) parts.push(`@${rest[0]!.slice(0, 24)}`);
  return parts.join(':');
}

interface TriageCluster {
  signature: string;
  examples: string[];
  count: number;
}

interface TriageStats {
  total: number;
  rewritten: number;
  notice: number;
  passthrough: number;
}

function triageCommands(
  commands: string[],
  cwd: string,
): {
  passthroughClusters: TriageCluster[];
  rewriteByTool: Map<string, number>;
  recognizerHits: Map<string, number>;
  stats: TriageStats;
} {
  const rewriteByTool = new Map<string, number>();
  const recognizerHits = new Map<string, number>();
  const clusters = new Map<string, TriageCluster>();
  let rewritten = 0;
  let notice = 0;
  let passthrough = 0;
  for (const command of commands) {
    let result: ReturnType<typeof tryRewriteBash>;
    try {
      result = tryRewriteBash(command, cwd);
    } catch {
      result = null;
    }
    if (result?.decision) {
      rewritten += 1;
      rewriteByTool.set(result.decision.tool, (rewriteByTool.get(result.decision.tool) ?? 0) + 1);
      recognizerHits.set(
        result.decision.recognizer,
        (recognizerHits.get(result.decision.recognizer) ?? 0) + 1,
      );
      continue;
    }
    if (result) {
      notice += 1;
      continue;
    }
    passthrough += 1;
    const sig = shapeSignature(command);
    const existing = clusters.get(sig);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 5) existing.examples.push(command);
    } else {
      clusters.set(sig, { signature: sig, examples: [command], count: 1 });
    }
  }
  return {
    passthroughClusters: [...clusters.values()].sort((a, b) => b.count - a.count),
    rewriteByTool,
    recognizerHits,
    stats: { total: commands.length, rewritten, notice, passthrough },
  };
}

function renderTriageMarkdown(args: {
  source: string;
  days: number | null;
  corpusPath: string;
  stats: TriageStats;
  rewriteByTool: Map<string, number>;
  recognizerHits: Map<string, number>;
  passthroughClusters: TriageCluster[];
  topClusters: number;
}): string {
  const pct = (n: number): string =>
    args.stats.total === 0 ? '0%' : `${((n / args.stats.total) * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('# bash-rewrite triage', '');
  lines.push(`Source: \`${args.source}\`${args.days !== null ? ` (last ${args.days} days)` : ''}`);
  lines.push(`Corpus: \`${args.corpusPath}\``, '');
  lines.push('## Summary', '');
  lines.push(`- total commands: **${args.stats.total}**`);
  lines.push(`- rewritten: **${args.stats.rewritten}** (${pct(args.stats.rewritten)})`);
  lines.push(`- notice-only: **${args.stats.notice}** (${pct(args.stats.notice)})`);
  lines.push(`- pass-through: **${args.stats.passthrough}** (${pct(args.stats.passthrough)})`, '');
  if (args.rewriteByTool.size > 0) {
    lines.push('### Rewrites by tool', '');
    for (const [tool, count] of [...args.rewriteByTool.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${tool}\`: ${count}`);
    }
    lines.push('');
  }
  if (args.recognizerHits.size > 0) {
    lines.push('### Rewrites by recognizer', '');
    for (const [rec, count] of [...args.recognizerHits.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${rec}\`: ${count}`);
    }
    lines.push('');
  }
  lines.push('## Top pass-through clusters', '');
  lines.push(
    'Signature format: `first-token[:pipeN][:redir][:subsh][:chain][:@second-token]`. ' +
      'Use these clusters to spot candidate recognizers.',
    '',
  );
  const top = args.passthroughClusters.slice(0, args.topClusters);
  if (top.length === 0) {
    lines.push('_(none)_');
    return lines.join('\n') + '\n';
  }
  for (const cluster of top) {
    lines.push(`### \`${cluster.signature}\` — ${cluster.count}`, '');
    for (const ex of cluster.examples) {
      lines.push('```');
      lines.push(ex);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// --- CLI --------------------------------------------------------------------

interface Args {
  source: 'pi-mono' | 'local';
  days: number;
  sessions: string;
  cacheDir: string;
  maxBytes: number;
  keepMultiline: boolean;
  redactUsername: string[];
  out: string;
  triage: boolean;
  triageOut: string | null;
  topClusters: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: 'pi-mono',
    days: 7,
    sessions: path.join(homedir(), '.pi/agent/sessions'),
    cacheDir: '/tmp/pi-mono-cache',
    maxBytes: 2048,
    keepMultiline: false,
    redactUsername: [],
    out: '',
    triage: false,
    triageOut: null,
    topClusters: 25,
  };
  const expectValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    switch (flag) {
      case '--from': {
        const v = expectValue(flag, i);
        if (v !== 'pi-mono' && v !== 'local') {
          throw new Error(`--from must be pi-mono or local, got ${v}`);
        }
        args.source = v;
        i += 1;
        break;
      }
      case '--days':
        args.days = Number(expectValue(flag, i));
        i += 1;
        break;
      case '--sessions':
        args.sessions = expectValue(flag, i);
        i += 1;
        break;
      case '--cache-dir':
        args.cacheDir = expectValue(flag, i);
        i += 1;
        break;
      case '--max-bytes':
        args.maxBytes = Number(expectValue(flag, i));
        i += 1;
        break;
      case '--keep-multiline':
        args.keepMultiline = true;
        break;
      case '--redact-username':
        args.redactUsername.push(expectValue(flag, i));
        i += 1;
        break;
      case '--out':
        args.out = expectValue(flag, i);
        i += 1;
        break;
      case '--triage':
        args.triage = true;
        break;
      case '--triage-out':
        args.triageOut = expectValue(flag, i);
        i += 1;
        break;
      case '--top-clusters':
        args.topClusters = Number(expectValue(flag, i));
        i += 1;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.out) throw new Error('--out is required');
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: extract-bash-corpus.ts [--from pi-mono|local] --out <path> [options]',
      '',
      'Options:',
      '  --from {pi-mono,local}     Corpus source. Default: pi-mono.',
      '  --days N                   Local mode only. Default: 7.',
      '  --sessions <dir>           Local mode only. Default: ~/.pi/agent/sessions.',
      '  --cache-dir <dir>          pi-mono parquet cache. Default: /tmp/pi-mono-cache.',
      '  --max-bytes N              Drop commands longer than N. Default: 2048.',
      '  --keep-multiline           Keep multi-line commands (default: drop).',
      '  --redact-username <name>   Extra username to redact (repeatable).',
      '  --out <path>               Output JSONL (required).',
      '  --triage                   Also write <out>.triage.md with cluster report.',
      '  --triage-out <path>        Override triage report path.',
      '  --top-clusters N           How many pass-through clusters to show. Default: 25.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usernames = new Set<string>([userInfo().username, ...args.redactUsername]);
  if (args.source === 'pi-mono') usernames.add('badlogic');
  const sanitizers = buildSanitizers([...usernames]);

  const raw =
    args.source === 'pi-mono'
      ? await pullFromPiMono({
          cacheDir: args.cacheDir,
          maxBytes: args.maxBytes,
          keepMultiline: args.keepMultiline,
        })
      : await pullFromLocal({
          sessions: args.sessions,
          days: args.days,
          maxBytes: args.maxBytes,
          keepMultiline: args.keepMultiline,
        });

  const unique = [...new Set(raw.map((c) => sanitize(c, sanitizers)))].sort();
  const outPath = path.resolve(args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = createWriteStream(outPath, { encoding: 'utf8' });
  for (const cmd of unique) stream.write(JSON.stringify({ command: cmd }) + '\n');
  stream.end();
  process.stderr.write(
    [
      `source=${args.source}`,
      `  raw bash calls        : ${raw.length}`,
      `  unique after sanitize : ${unique.length}`,
      `  output                : ${outPath}`,
      '',
    ].join('\n'),
  );

  if (args.triage) {
    const { stats, rewriteByTool, recognizerHits, passthroughClusters } = triageCommands(
      unique,
      outPath,
    );
    const md = renderTriageMarkdown({
      source: args.source,
      days: args.source === 'local' ? args.days : null,
      corpusPath: outPath,
      stats,
      rewriteByTool,
      recognizerHits,
      passthroughClusters,
      topClusters: args.topClusters,
    });
    const triagePath = path.resolve(args.triageOut ?? outPath + '.triage.md');
    writeFileSync(triagePath, md);
    process.stderr.write(
      [
        `triage written         : ${triagePath}`,
        `  rewritten            : ${stats.rewritten}/${stats.total}`,
        `  notice-only          : ${stats.notice}/${stats.total}`,
        `  pass-through         : ${stats.passthrough}/${stats.total}`,
        `  distinct pt-clusters : ${passthroughClusters.length}`,
        '',
      ].join('\n'),
    );
  }
}

// Only run when invoked as a script.
if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
