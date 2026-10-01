import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { engineJob } from '@/lib/jobs/engine/registry';
import {
  HOSTED_RUN_SUPERVISE_TRANSACTION_RETRY_MS,
  hostedRunSupervise,
} from '@/lib/jobs/definitions/hostedRunSupervise';
import type { HostedRunSuperviseData } from '@/lib/jobs/types';

// A SUPERVISE PASS THAT COULD NOT START A TRANSACTION IS DEFERRED, NOT DEAD-LETTERED
// (Bug MOTIR-7071).
//
// `hosted-run/supervise` runs on `retryPolicy: 'none'`, so any throw out of a pass
// ends the supervision for good. In the acceptance lane the job worker's pool was
// saturated for twenty minutes; one pass of a hosted continue met a P2028
// "Unable to start a transaction in the given time" and the job logged
// `FAILED terminally`, so the stall read that should have ended the silent run
// 25 s later never ran again and its card never came back to To fix.
//
// Driven through the ENGINE registry's own handler — the function the worker
// invokes — with `supervise` stubbed to throw what the worker saw.

const NOW = new Date('2026-09-30T20:41:15.000Z');

const data = {
  workspaceId: 'ws-1',
  dispatchRunId: 'run-1',
  session: {},
  idempotencyKey: 'hosted-run:run-1',
} as unknown as HostedRunSuperviseData;

function prismaError(message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2028',
    clientVersion: '7.9.0',
    meta: {},
  });
}

const MAX_WAIT = 'Transaction API error: Unable to start a transaction in the given time.';
const EXPIRED =
  'Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5108 ms passed since the start of the transaction.';

async function runPass(supervise: () => Promise<unknown>): Promise<unknown> {
  const handler = engineJob('hosted-run/supervise')!.handler;
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  return handler(
    { event: { name: 'hosted-run/supervise', data }, runId: 'job-run-1', step } as never,
    { hostedRun: { supervise: vi.fn(supervise) } } as never,
  );
}

describe('hosted-run/supervise — a pass that could not start a transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps its single attempt for every other failure', () => {
    expect(hostedRunSupervise.retryPolicy).toBe('none');
  });

  it('DEFERS the pass when no connection came free (P2028, the maxWait half)', async () => {
    const thrown = await runPass(async () => {
      throw prismaError(MAX_WAIT);
    }).catch((err: unknown) => err);

    expect(isJobRunDefer(thrown)).toBe(true);
    if (!isJobRunDefer(thrown)) return;
    expect(thrown.resumeAt.getTime()).toBe(
      NOW.getTime() + HOSTED_RUN_SUPERVISE_TRANSACTION_RETRY_MS,
    );
    expect(thrown.reason).toContain('run-1');
  });

  it('defers when the P2028 arrives as the cause of a translated error', async () => {
    const thrown = await runPass(async () => {
      throw new Error('the supervision store could not be read', { cause: prismaError(MAX_WAIT) });
    }).catch((err: unknown) => err);

    expect(isJobRunDefer(thrown)).toBe(true);
  });

  it('rethrows a transaction that EXPIRED mid-body (the timeout half) unchanged', async () => {
    const expired = prismaError(EXPIRED);
    const thrown = await runPass(async () => {
      throw expired;
    }).catch((err: unknown) => err);

    expect(thrown).toBe(expired);
  });

  it('rethrows any other failure unchanged', async () => {
    const other = new Error('the orchestrator refused the poll');
    const thrown = await runPass(async () => {
      throw other;
    }).catch((err: unknown) => err);

    expect(thrown).toBe(other);
  });

  it('passes a defer the supervision itself raised straight through', async () => {
    const own = await runPass(async () => {
      const { deferRun } = await import('@/lib/jobs/engine/defer');
      deferRun(new Date(NOW.getTime() + 30_000), 'polling');
    }).catch((err: unknown) => err);

    expect(isJobRunDefer(own)).toBe(true);
    if (!isJobRunDefer(own)) return;
    expect(own.reason).toBe('polling');
  });

  it('returns the settled outcome of a pass that finished', async () => {
    const outcome = { outcome: 'settled' };
    await expect(runPass(async () => outcome)).resolves.toBe(outcome);
  });
});
