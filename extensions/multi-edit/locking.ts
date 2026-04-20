import { resolve } from 'node:path';

import { withFileMutationQueue } from '@mariozechner/pi-coding-agent';

function canonicalize(filePath: string): string {
  return resolve(filePath);
}

export async function withFilesMutationQueue<T>(
  filePaths: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const paths = [...new Set(filePaths.map(canonicalize))].sort();

  async function run(index: number): Promise<T> {
    if (index >= paths.length) {
      return fn();
    }
    return withFileMutationQueue(paths[index], () => run(index + 1));
  }

  return run(0);
}
