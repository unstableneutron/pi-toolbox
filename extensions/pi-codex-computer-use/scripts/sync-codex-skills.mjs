#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_SKILL_COPIES = [
  { plugin: 'computer-use', skill: 'computer-use', destination: 'computer-use' },
  { plugin: 'browser', skill: 'control-in-app-browser', destination: 'control-in-app-browser' },
  { plugin: 'chrome', skill: 'control-chrome', destination: 'control-chrome' },
];

const DEFAULT_CODEX_APP = '/Applications/Codex.app';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexApp = process.env.PI_COMPUTER_USE_CODEX_APP || DEFAULT_CODEX_APP;

function sourceRoot(plugin) {
  return path.join(codexApp, 'Contents/Resources/plugins/openai-bundled/plugins', plugin, 'skills');
}

async function copyDirectory(src, dst) {
  await fs.rm(dst, { force: true, recursive: true });
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true });
}

for (const copy of CODEX_SKILL_COPIES) {
  const src = path.join(sourceRoot(copy.plugin), copy.skill);
  const dst = path.join(root, 'skills', copy.destination);
  await copyDirectory(src, dst);
  console.log(`synced ${copy.plugin}/${copy.skill} -> ${path.relative(root, dst)}`);
}
