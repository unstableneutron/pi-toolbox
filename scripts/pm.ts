#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

import {
  formatPackageManagerCommand,
  resolvePackageManagerCommand,
} from './pi-update-extensions.ts';

function withNoInstallForAubeRunCommands(command: string, argv: string[]): string[] {
  if (command !== 'aube') return argv;
  const [subcommand, ...rest] = argv;
  if ((subcommand !== 'run' && subcommand !== 'exec') || rest.includes('--no-install')) {
    return argv;
  }
  return [subcommand, '--no-install', ...rest];
}

function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length === 0) {
    console.error('Usage: scripts/pm.ts <package-manager-args...>');
    return 1;
  }

  const packageManager = resolvePackageManagerCommand({ cwd: process.cwd() });
  const packageManagerArgs = withNoInstallForAubeRunCommands(packageManager.command, argv);
  const env = { ...process.env };
  if (packageManager.command.endsWith('pnpm-npm-shim.sh')) {
    env.PI_NPM_SHIM_NO_INSTALL ??= '1';
  }
  console.error(`Running: ${formatPackageManagerCommand(packageManager, packageManagerArgs)}`);

  const result = spawnSync(
    packageManager.command,
    [...packageManager.args, ...packageManagerArgs],
    {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

process.exitCode = main();
