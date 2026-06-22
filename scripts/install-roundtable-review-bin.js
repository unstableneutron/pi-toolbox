#!/usr/bin/env node

import { chmod, lstat, mkdir, symlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return `install-roundtable-review-bin - link roundtable-review into a user bin dir

Usage:
  node ./scripts/install-roundtable-review-bin.js [options]

Options:
  --bin-dir <dir>  Target directory (default: ~/.local/bin)
  --force          Replace an existing non-symlink target
  --dry-run        Print what would happen without changing files
  -h, --help       Show this help
`;
}

function parseArgs(argv) {
  const options = {
    binDir: process.env.LOCAL_BIN_DIR || join(homedir(), '.local', 'bin'),
    force: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--bin-dir': {
        const value = argv[++i];
        if (!value) throw new Error('--bin-dir requires a value');
        options.binDir = value;
        break;
      }
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.binDir = resolve(options.binDir.replace(/^~(?=$|\/)/, homedir()));
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(repoRoot, 'packages', 'roundtable-review', 'bin', 'roundtable-review.js');
  const target = join(options.binDir, 'roundtable-review');

  if (!existsSync(source)) throw new Error(`CLI source not found: ${source}`);

  console.log(`${options.dryRun ? 'Would link' : 'Linking'} ${target} -> ${source}`);
  if (options.dryRun) return 0;

  await mkdir(options.binDir, { recursive: true });
  await chmod(source, 0o755);

  const targetStat = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

  if (targetStat) {
    const targetIsSymlink = targetStat.isSymbolicLink();

    if (!targetIsSymlink && !options.force) {
      throw new Error(
        `Refusing to replace non-symlink target: ${target}\nRe-run with --force to replace it.`,
      );
    }
    await unlink(target);
  }

  await symlink(source, target);
  console.log(`Installed: ${target}`);
  console.log('Ensure ~/.local/bin is on PATH, then run: roundtable-review --help');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`install-roundtable-review-bin: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
  },
);
