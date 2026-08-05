import { randomUUID } from 'node:crypto';

export interface ExecutorRunningJob {
  status: 'running';
  jobId: string;
  label: string;
  elapsedMs: number;
  pollAfterMs: number;
}

export type ExecutorJobOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: unknown }
  | ExecutorRunningJob;

interface JobRecord {
  id: string;
  label: string;
  startedAt: number;
  controller: AbortController;
  status: 'running' | 'completed' | 'failed';
  value?: unknown;
  error?: unknown;
  settled: Promise<void>;
}

const DEFAULT_POLL_AFTER_MS = 5_000;
const MAX_JOBS = 20;

async function waitUntilSettledOrTimeout(settled: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ExecutorJobManager {
  readonly #jobs = new Map<string, JobRecord>();

  async run<T>(
    label: string,
    yieldAfterMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<ExecutorJobOutcome<T>> {
    const controller = new AbortController();
    const record: JobRecord = {
      id: randomUUID(),
      label,
      startedAt: Date.now(),
      controller,
      status: 'running',
      settled: Promise.resolve(),
    };
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    while (this.#jobs.size >= MAX_JOBS) {
      const oldest = this.#jobs.values().next().value as JobRecord | undefined;
      if (!oldest) break;
      oldest.controller.abort(new Error('Executor job evicted'));
      this.#jobs.delete(oldest.id);
    }

    record.settled = operation(controller.signal).then(
      (value) => {
        record.status = 'completed';
        record.value = value;
      },
      (error: unknown) => {
        record.status = 'failed';
        record.error = error;
      },
    );
    this.#jobs.set(record.id, record);

    await waitUntilSettledOrTimeout(record.settled, yieldAfterMs);
    signal?.removeEventListener('abort', abort);
    if (record.status === 'running') return this.#running(record);
    this.#jobs.delete(record.id);
    return this.#outcome<T>(record);
  }

  async poll<T>(jobId: string, waitMs: number): Promise<ExecutorJobOutcome<T> | undefined> {
    const record = this.#jobs.get(jobId);
    if (!record) return undefined;
    if (record.status === 'running' && waitMs > 0) {
      await waitUntilSettledOrTimeout(record.settled, waitMs);
    }
    if (record.status === 'running') return this.#running(record);
    this.#jobs.delete(jobId);
    return this.#outcome<T>(record);
  }

  cancel(jobId: string): boolean {
    const record = this.#jobs.get(jobId);
    if (!record) return false;
    record.controller.abort(new Error('Executor job cancelled'));
    this.#jobs.delete(jobId);
    return true;
  }

  cancelAll(): void {
    for (const record of this.#jobs.values()) {
      record.controller.abort(new Error('Executor session closed'));
    }
    this.#jobs.clear();
  }

  #running(record: JobRecord): ExecutorRunningJob {
    return {
      status: 'running',
      jobId: record.id,
      label: record.label,
      elapsedMs: Date.now() - record.startedAt,
      pollAfterMs: DEFAULT_POLL_AFTER_MS,
    };
  }

  #outcome<T>(record: JobRecord): ExecutorJobOutcome<T> {
    return record.status === 'completed'
      ? { status: 'completed', value: record.value as T }
      : { status: 'failed', error: record.error };
  }
}
