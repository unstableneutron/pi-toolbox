#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { tryRewriteBash } from '../bash-rewrite.ts';

const lines = readFileSync(process.argv[2]!, 'utf8').trim().split('\n');
const target = process.argv[3]!;
const limit = Number(process.argv[4] ?? 40);
const shown = new Set<string>();
let seen = 0;
for (const line of lines) {
  const { command } = JSON.parse(line);
  // Strip `cd PATH && ` prefix so we find the real work token.
  const work = command.replace(/^cd [^&]+&& */, '');
  const firstTok = work.split(/\s+/)[0] ?? '';
  if (firstTok !== target && !firstTok.endsWith('/' + target)) continue;
  const rewrite = tryRewriteBash(command, '/');
  if (rewrite?.decision) continue; // already rewritten
  seen++;
  // Dedupe by normalized shape: first 80 chars
  const key = work.slice(0, 80);
  if (shown.has(key)) continue;
  shown.add(key);
  if (shown.size > limit) break;
  console.log(work.slice(0, 200));
}
console.error(`pass-through ${target}: ${seen} total, ${shown.size} unique shapes shown`);
