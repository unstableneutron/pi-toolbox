import { describe, expect, test } from 'vitest';

import { ExecutorJobManager } from './job-manager';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ExecutorJobManager', () => {
  test('yields a running job and returns its result through polling', async () => {
    const jobs = new ExecutorJobManager();
    const started = await jobs.run(5, undefined, async () => {
      await delay(25);
      return { value: 42 };
    });

    expect(started).toMatchObject({ status: 'running' });
    if (started.status !== 'running') throw new Error('Expected a running job');

    const completed = await jobs.poll<{ value: number }>(started.jobId, 100);
    expect(completed).toEqual({ status: 'completed', value: { value: 42 } });
    expect(await jobs.poll(started.jobId, 0)).toBeUndefined();
  });

  test('returns fast operations inline without retaining a job', async () => {
    const jobs = new ExecutorJobManager();
    const outcome = await jobs.run(100, undefined, async () => 'done');

    expect(outcome).toEqual({ status: 'completed', value: 'done' });
  });

  test('cancels a yielded job', async () => {
    const jobs = new ExecutorJobManager();
    const started = await jobs.run(5, undefined, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return 'unreachable';
    });

    if (started.status !== 'running') throw new Error('Expected a running job');
    expect(jobs.cancel(started.jobId)).toBe(true);
    expect(await jobs.poll(started.jobId, 0)).toBeUndefined();
  });
});
