/**
 * Shared Pi launcher wrapper for native terminal splits.
 *
 * Builds `/bin/sh shared/native-pi-launcher.sh <cwd> <session> <prompt> <marker>`
 * argv used by Ghostty/Kitty/Herdr pane launches.
 */

import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_PI_LAUNCH_EMPTY_VALUE = '__PI_NATIVE_SPLIT_EMPTY__';

export function getNativePiLauncherScriptPath(): string {
  return fileURLToPath(new URL('./native-pi-launcher.sh', import.meta.url));
}

function writePromptFile(prompt: string): string {
  // Keep the historical temp prefix so existing tests and shell scrapers still match.
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-'));
  const promptFile = path.join(promptDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  return promptFile;
}

export function cleanupNativePiPromptTempPath(promptFile: string | undefined): void {
  if (!promptFile) return;
  try {
    fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

export function buildNativePiLaunchArgs(options: {
  cwd: string;
  sessionFile?: string;
  prompt?: string;
  markerFile?: string;
}): { argv: string[]; promptFile?: string; markerFile?: string } {
  const prompt = options.prompt ?? '';
  const promptFile = prompt.length > 0 ? writePromptFile(prompt) : undefined;

  return {
    argv: [
      '/bin/sh',
      getNativePiLauncherScriptPath(),
      options.cwd,
      options.sessionFile ?? NATIVE_PI_LAUNCH_EMPTY_VALUE,
      promptFile ?? NATIVE_PI_LAUNCH_EMPTY_VALUE,
      options.markerFile ?? NATIVE_PI_LAUNCH_EMPTY_VALUE,
    ],
    promptFile,
    markerFile: options.markerFile,
  };
}
