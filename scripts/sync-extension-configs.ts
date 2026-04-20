#!/usr/bin/env bun
/**
 * Sync JSON configs consumed by npm-installed pi extensions between
 *
 *   repo: <pi-toolbox>/extensions-config/
 *   live: ~/.pi/agent/extensions/
 *
 * Default behaviour is a read-only status + unified diff (dry-run).
 * Pass --apply to walk each differing file interactively and pick a
 * direction per file. Writes are atomic (copyFileSync).
 *
 *   bun run scripts/sync-extension-configs.ts           # dry-run
 *   bun run scripts/sync-extension-configs.ts --apply   # interactive
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(REPO_ROOT, 'extensions-config');
const LIVE_DIR = join(homedir(), '.pi', 'agent', 'extensions');

// Minimal ANSI palette. Respect NO_COLOR and non-TTY stdout.
const SUPPORTS_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code: string) => (SUPPORTS_COLOR ? code : '');
const GREEN = ansi('\x1b[32m');
const RED = ansi('\x1b[31m');
const YELLOW = ansi('\x1b[33m');
const DIM = ansi('\x1b[2m');
const BOLD = ansi('\x1b[1m');
const RESET = ansi('\x1b[0m');

type PairStatus =
  | { kind: 'in-sync' }
  | { kind: 'repo-only' }
  | { kind: 'differs'; repoMtime: Date; liveMtime: Date };

interface FilePair {
  rel: string;
  repoPath: string;
  livePath: string;
  status: PairStatus;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

function classify(): FilePair[] {
  const pairs: FilePair[] = [];
  for (const repoPath of listFiles(REPO_DIR)) {
    const rel = relative(REPO_DIR, repoPath);
    // Skip the README; it's documentation, not a synced config.
    if (rel === 'README.md') continue;
    const livePath = join(LIVE_DIR, rel);
    if (!existsSync(livePath)) {
      pairs.push({ rel, repoPath, livePath, status: { kind: 'repo-only' } });
      continue;
    }
    const repoContent = readFileSync(repoPath, 'utf8');
    const liveContent = readFileSync(livePath, 'utf8');
    if (repoContent === liveContent) {
      pairs.push({ rel, repoPath, livePath, status: { kind: 'in-sync' } });
    } else {
      pairs.push({
        rel,
        repoPath,
        livePath,
        status: {
          kind: 'differs',
          repoMtime: statSync(repoPath).mtime,
          liveMtime: statSync(livePath).mtime,
        },
      });
    }
  }
  return pairs;
}

function unifiedDiff(
  repoContent: string,
  liveContent: string,
  repoLabel: string,
  liveLabel: string,
): string {
  // Naive line-by-line diff; sufficient for short JSON files.
  const a = repoContent.split('\n');
  const b = liveContent.split('\n');
  const lines: string[] = [];
  lines.push(`${DIM}--- ${repoLabel}${RESET}`);
  lines.push(`${DIM}+++ ${liveLabel}${RESET}`);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left !== undefined) lines.push(`${RED}- ${left}${RESET}`);
    if (right !== undefined) lines.push(`${GREEN}+ ${right}${RESET}`);
  }
  return lines.join('\n');
}

function printStatus(pairs: FilePair[]): void {
  console.log(`${BOLD}sync-extension-configs${RESET}`);
  console.log(`  repo: ${REPO_DIR}`);
  console.log(`  live: ${LIVE_DIR}\n`);
  for (const p of pairs) {
    switch (p.status.kind) {
      case 'in-sync':
        console.log(`  ${GREEN}✓${RESET} in sync   ${p.rel}`);
        break;
      case 'repo-only':
        console.log(`  ${YELLOW}?${RESET} live missing ${p.rel}`);
        break;
      case 'differs': {
        const { repoMtime, liveMtime } = p.status;
        const newer = repoMtime > liveMtime ? 'repo' : 'live';
        console.log(
          `  ${RED}✗${RESET} differs   ${p.rel}  ${DIM}(newer: ${newer}; repo ${repoMtime.toISOString()} / live ${liveMtime.toISOString()})${RESET}`,
        );
        break;
      }
    }
  }
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    rl.question(question, (ans) => resolvePrompt(ans.trim()));
  });
}

async function interactiveApply(pairs: FilePair[]): Promise<void> {
  const changed = pairs.filter((p) => p.status.kind !== 'in-sync');
  if (changed.length === 0) {
    console.log(`\n${GREEN}All in sync. Nothing to do.${RESET}`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let applied = 0;
  let skipped = 0;
  for (const p of changed) {
    console.log(`\n${BOLD}${p.rel}${RESET}`);
    if (p.status.kind === 'repo-only') {
      console.log(`  live path is missing (${p.livePath})`);
      const ans = (await prompt(rl, '  [>] push repo→live   [s] skip   [q] quit: ')).toLowerCase();
      if (ans === 'q') break;
      if (ans === '>') {
        mkdirSync(dirname(p.livePath), { recursive: true });
        copyFileSync(p.repoPath, p.livePath);
        console.log(`  ${GREEN}pushed${RESET}`);
        applied++;
      } else {
        skipped++;
      }
      continue;
    }
    if (p.status.kind === 'differs') {
      const repoContent = readFileSync(p.repoPath, 'utf8');
      const liveContent = readFileSync(p.livePath, 'utf8');
      console.log(unifiedDiff(repoContent, liveContent, `${p.rel} (repo)`, `${p.rel} (live)`));
      const ans = (
        await prompt(rl, '  [<] pull live→repo   [>] push repo→live   [s] skip   [q] quit: ')
      ).toLowerCase();
      if (ans === 'q') break;
      if (ans === '<') {
        copyFileSync(p.livePath, p.repoPath);
        console.log(`  ${GREEN}pulled${RESET}`);
        applied++;
      } else if (ans === '>') {
        mkdirSync(dirname(p.livePath), { recursive: true });
        copyFileSync(p.repoPath, p.livePath);
        console.log(`  ${GREEN}pushed${RESET}`);
        applied++;
      } else {
        skipped++;
      }
    }
  }
  rl.close();
  console.log(`\n${BOLD}Summary:${RESET} ${applied} applied, ${skipped} skipped`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pairs = classify();
  printStatus(pairs);
  const differing = pairs.filter((p) => p.status.kind !== 'in-sync');
  if (!apply) {
    if (differing.length > 0) {
      for (const p of differing) {
        if (p.status.kind === 'differs') {
          console.log(`\n${BOLD}${p.rel}${RESET}`);
          console.log(
            unifiedDiff(
              readFileSync(p.repoPath, 'utf8'),
              readFileSync(p.livePath, 'utf8'),
              `${p.rel} (repo)`,
              `${p.rel} (live)`,
            ),
          );
        }
      }
      console.log(`\n${DIM}Run with --apply to interactively choose a direction per file.${RESET}`);
      process.exitCode = 1;
    }
    return;
  }
  await interactiveApply(pairs);
}

void main();
