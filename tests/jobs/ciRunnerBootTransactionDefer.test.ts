import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { engineJob } from '@/lib/jobs/engine/registry';
import {
  CI_RUNNER_BOOT_TRANSACTION_RETRY_MS,
  ciRunnerBoot,
} from '@/lib/jobs/definitions/ciRunnerFleet';

// A CI-RUNNER BOOT PASS THAT COULD NOT START A TRANSACTION IS DEFERRED, NOT
// DEAD-LETTERED (Bug MOTIR-7074) — `hosted-run/supervise`'s MOTIR-7071 fix, for the
// one other supervisor on `retryPolicy: 'none'`.
//
// With a budget of ONE, a pass meeting P2028's `maxWait` half ("Unable to start a
// transaction in the given time") used to fail the whole CI supervision terminally,
// leaving the intent and its machine to the abandoned-supervision sweep.
//
// Driven through the ENGINE registry's own handler — the function the worker
// invokes — with `advanceIntent` stubbed to throw what the worker would see.
// Mirrors `tests/hostedRuns/hostedRunSuperviseTransactionDefer.test.ts`.

const NOW = new Date('2026-10-01T06:00:00.000Z');

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

async function runPass(advanceIntent: () => Promise<unknown>): Promise<unknown> {
  const handler = engineJob('system.ci-runner-boot')!.handler;
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  return handler(
    {
      event: { name: 'system.ci-runner-boot', data: { intentId: 'intent-1' } },
      runId: 'job-run-1',
      step,
    } as never,
    { ciRunnerBoot: { advanceIntent: vi.fn(advanceIntent) } } as never,
  );
}

describe('system.ci-runner-boot — a pass that could not start a transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps its single attempt for every other failure', () => {
    expect(ciRunnerBoot.retryPolicy).toBe('none');
  });

  it('DEFERS the pass when no connection came free (P2028, the maxWait half)', async () => {
    const thrown = await runPass(async () => {
      throw prismaError(MAX_WAIT);
    }).catch((err: unknown) => err);

    expect(isJobRunDefer(thrown)).toBe(true);
    if (!isJobRunDefer(thrown)) return;
    expect(thrown.resumeAt.getTime()).toBe(NOW.getTime() + CI_RUNNER_BOOT_TRANSACTION_RETRY_MS);
    expect(thrown.reason).toContain('intent-1');
  });

  it('defers when the P2028 arrives as the cause of a translated error', async () => {
    const thrown = await runPass(async () => {
      throw new Error('the intent could not be read', { cause: prismaError(MAX_WAIT) });
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
    const other = new Error('the orchestrator refused the boot');
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

  it('returns the outcome of a pass that finished', async () => {
    const outcome = { outcome: 'settled' };
    await expect(runPass(async () => outcome)).resolves.toBe(outcome);
  });
});
