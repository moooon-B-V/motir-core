import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { EMAIL_QUOTA_EXHAUSTED_CODE, getEmailProvider } from '@/lib/email';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { defineJob } from '@/lib/jobs/defineJob';
import { JobWorker, isNonRetryableFailure } from '@/lib/jobs/engine/worker';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A spent provider QUOTA dead-letters on its FIRST attempt (MOTIR-5873), against
// a real Postgres and the real worker loop.
//
// Production held 277 `email.send` dead letters from one 38-hour burst, every
// one `EMAIL_TRANSIENT_FAILURE … HTTP 429 (daily_quota_exceeded)`. The job runs
// `retryPolicy: 'transient'` — three attempts minutes apart — so each send asked
// an exhausted quota three times and was then filed as a BLIP. The two halves of
// the fix meet here: `lib/email.ts` classifies the quota 429 as non-retryable,
// and the worker honours `retryable === false`. Neither half is asserted by
// calling the other directly: the handler throws what the real Resend provider
// throws for a mocked response, and the rows are the ones an operator reads.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const PROVIDER_ENV = ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM'] as const;
const original: Record<string, string | undefined> = {};

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  for (const key of PROVIDER_ENV) original[key] = process.env[key];
  process.env['EMAIL_PROVIDER'] = 'resend';
  process.env['RESEND_API_KEY'] = 'test-resend-key';
  process.env['EMAIL_FROM'] = 'Motir <no-reply@motir.co>';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Resend's error envelope at a status — a FRESH Response per call (a body reads once). */
function stubResend(status: number, name: string, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ statusCode: status, name, message }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

let seq = 0;

/**
 * Register a throwaway job whose handler is ONE real Resend send, and enqueue a
 * run of it with the `transient` policy's budget of three — the budget
 * `email.send` itself carries.
 */
async function seedSendJob(): Promise<{ jobId: string; runId: string; workspaceId: string }> {
  seq += 1;
  const jobId = `email.quota.probe.${seq}`;
  defineJob({ id: jobId as never, retryPolicy: 'transient' }, async () => {
    await getEmailProvider()({
      to: 'mo@example.com',
      subject: 'A watcher notification',
      html: '<p>moved to Done</p>',
      idempotencyKey: `quota-${seq}`,
    });
  });

  const user = await usersService.createUser({
    email: `quota-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Quota ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Quota WS ${seq}`,
    ownerUserId: user.id,
  });
  const event = await adminDb.jobEvent.create({
    data: { name: jobId, data: { workspaceId: workspace.id }, workspaceId: workspace.id },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId,
      eventId: event.id,
      eventName: jobId,
      workspaceId: workspace.id,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  return { jobId, runId: run.id, workspaceId: workspace.id };
}

function worker(workspaceId: string, outcomes: string[]): JobWorker {
  return new JobWorker({
    workerId: 'email-quota',
    logger: silent,
    onOutcome: (_run, outcome) => outcomes.push(outcome),
    execute: async (r) => {
      await executeWithLedger(r, { workspaceId });
    },
    onTerminalFailure: async (r, e) => recordEngineTerminalFailure(r, e, { workspaceId }),
  });
}

function readRun(id: string): Promise<JobQueueRun> {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

describe('a spent Resend quota', () => {
  it('dead-letters on the FIRST attempt, under EMAIL_QUOTA_EXHAUSTED, with two attempts unspent', async () => {
    stubResend(429, 'daily_quota_exceeded', 'You have reached your daily email sending quota.');
    const { jobId, runId, workspaceId } = await seedSendJob();
    const outcomes: string[] = [];
    const w = worker(workspaceId, outcomes);

    await w.tick();
    await w.settled();

    // ONE pass, and it is terminal — no `retrying`, no second request to the provider.
    expect(outcomes).toEqual(['failed']);
    const queued = await readRun(runId);
    expect(queued.state).toBe('failed');
    expect(queued.attempts).toBe(1);
    expect(queued.maxAttempts).toBe(3);

    const dlq = await adminDb.jobRunDlq.findMany({ where: { functionId: jobId } });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.attempts).toBe(1);
    // The dead-letter row names the real cause, not a transient blip.
    expect(dlq[0]?.failure).toMatchObject({ code: EMAIL_QUOTA_EXHAUSTED_CODE });
    expect((dlq[0]?.failure as { message: string }).message).toContain('daily_quota_exceeded');
  });

  it('a plain 429 RATE LIMIT still retries on the transient schedule and dead-letters nothing', async () => {
    stubResend(429, 'rate_limit_exceeded', 'Too many requests');
    const { jobId, runId, workspaceId } = await seedSendJob();
    const outcomes: string[] = [];
    const w = worker(workspaceId, outcomes);

    await w.tick();
    await w.settled();

    expect(outcomes).toEqual(['retrying']);
    const queued = await readRun(runId);
    expect(queued.state).toBe('pending');
    expect(queued.attempts).toBe(1);
    expect(await adminDb.jobRunDlq.count({ where: { functionId: jobId } })).toBe(0);
  });
});

describe('isNonRetryableFailure', () => {
  it('is true ONLY for an explicit `retryable: false`', () => {
    expect(isNonRetryableFailure(Object.assign(new Error('x'), { retryable: false }))).toBe(true);
    // Everything that says nothing keeps its whole budget — no existing job changes.
    expect(isNonRetryableFailure(Object.assign(new Error('x'), { retryable: true }))).toBe(false);
    expect(isNonRetryableFailure(new Error('x'))).toBe(false);
    expect(isNonRetryableFailure({ retryable: 'false' })).toBe(false);
    expect(isNonRetryableFailure({ retryable: 0 })).toBe(false);
    expect(isNonRetryableFailure(null)).toBe(false);
    expect(isNonRetryableFailure(undefined)).toBe(false);
    expect(isNonRetryableFailure('retryable: false')).toBe(false);
  });
});
