import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobRunState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobQueueRetentionService } from '@/lib/services/jobQueueRetentionService';
import { JOB_QUEUE_RETENTION_MS } from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Story MOTIR-8540 · Subtask MOTIR-8587 — the queue retention pass against the
// REAL database: which rows survive, the scheduler's watermark, dedup inside the
// window, the event orphan rule, the batch bound and the backlog drain.
//
// Every case seeds rows either side of the window with `adminDb`, runs
// `purgeExpired` with a pinned `now`, and reads the survivors back BY ID — a
// predicate that deletes the wrong row of an equal count must fail here.
//
// Ages: queue rows by `job_queue.created_at`, events by `job_event.received_at`
// (the table has no `created_at`).

const NOW = new Date('2026-10-14T06:15:00Z');
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - JOB_QUEUE_RETENTION_MS - DAY);
const YOUNG = new Date(NOW.getTime() - DAY);

beforeEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function run(opts: {
  state: JobRunState;
  createdAt: Date;
  jobId?: string;
  id?: string;
  eventId?: string | null;
  scheduledFor?: Date | null;
  idempotencyKey?: string | null;
  steps?: number;
}): Promise<string> {
  seq += 1;
  const id = opts.id ?? `run-${seq}`;
  await adminDb.jobQueueRun.create({
    data: {
      id,
      jobId: opts.jobId ?? 'test.retention',
      eventName: 'test/retention',
      eventId: opts.eventId ?? null,
      scheduledFor: opts.scheduledFor ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      runAt: opts.createdAt,
      maxAttempts: 3,
      state: opts.state,
      createdAt: opts.createdAt,
    },
  });
  for (let i = 0; i < (opts.steps ?? 0); i += 1) {
    await adminDb.jobStep.create({ data: { runId: id, stepId: `s${i}`, result: {} } });
  }
  return id;
}

async function event(id: string, receivedAt: Date): Promise<string> {
  await adminDb.jobEvent.create({ data: { id, name: 'test/retention', data: {}, receivedAt } });
  return id;
}

async function runIds(): Promise<string[]> {
  const rows = await adminDb.jobQueueRun.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}

async function eventIds(): Promise<string[]> {
  const rows = await adminDb.jobEvent.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}

async function stepRunIds(): Promise<string[]> {
  const rows = await adminDb.jobStep.findMany({
    select: { runId: true },
    orderBy: { runId: 'asc' },
  });
  return rows.map((r) => r.runId);
}

describe('the job_queue retention pass (MOTIR-8587)', () => {
  it('deletes only old succeeded rows and their steps; live, failed and young rows survive', async () => {
    await run({ id: 'old-succeeded', state: 'succeeded', createdAt: OLD, steps: 2 });
    await run({ id: 'old-pending', state: 'pending', createdAt: OLD, steps: 1 });
    await run({ id: 'old-running', state: 'running', createdAt: OLD });
    await run({ id: 'old-failed', state: 'failed', createdAt: OLD });
    await run({ id: 'old-cancelled', state: 'cancelled', createdAt: OLD });
    await run({ id: 'young-succeeded', state: 'succeeded', createdAt: YOUNG, steps: 1 });

    const report = await jobQueueRetentionService.purgeExpired({ now: NOW });

    expect(report).toMatchObject({ jobQueue: 1, jobStep: 2, drained: true });
    expect(await runIds()).toEqual([
      'old-cancelled',
      'old-failed',
      'old-pending',
      'old-running',
      'young-succeeded',
    ]);
    expect(await stepRunIds()).toEqual(['old-pending', 'young-succeeded']);
  });

  it("keeps each job's newest scheduled_for row, so latestScheduledFor is unchanged", async () => {
    // Job A: every scheduled row is old — the newest tick survives.
    const t = (h: number) => new Date(OLD.getTime() - h * 60 * 60 * 1000);
    await run({
      id: 'a-1',
      jobId: 'job.a',
      state: 'succeeded',
      createdAt: t(3),
      scheduledFor: t(3),
    });
    await run({
      id: 'a-2',
      jobId: 'job.a',
      state: 'succeeded',
      createdAt: t(2),
      scheduledFor: t(2),
    });
    await run({
      id: 'a-3',
      jobId: 'job.a',
      state: 'succeeded',
      createdAt: t(1),
      scheduledFor: t(1),
    });
    // Job B: a newer PENDING row is the newest, so the old succeeded row goes.
    await run({
      id: 'b-old',
      jobId: 'job.b',
      state: 'succeeded',
      createdAt: t(2),
      scheduledFor: t(2),
    });
    await run({
      id: 'b-pending',
      jobId: 'job.b',
      state: 'pending',
      createdAt: YOUNG,
      scheduledFor: YOUNG,
    });
    // Job C: event-driven rows with no scheduled_for protect nothing.
    await run({ id: 'c-1', jobId: 'job.c', state: 'succeeded', createdAt: t(2) });
    await run({ id: 'c-2', jobId: 'job.c', state: 'succeeded', createdAt: t(1) });

    const watermark = (jobId: string) =>
      withSystemContext((tx) => jobQueueRepository.latestScheduledFor(jobId, tx));
    const beforeA = await watermark('job.a');
    const beforeB = await watermark('job.b');

    await jobQueueRetentionService.purgeExpired({ now: NOW });

    expect(await watermark('job.a')).toEqual(beforeA);
    expect(await watermark('job.b')).toEqual(beforeB);
    expect(await runIds()).toEqual(['a-3', 'b-pending']);
  });

  it('dedups every unique key inside the window, and a key older than the window enqueues again', async () => {
    await event('ev-young', YOUNG);
    await run({ id: 'k', state: 'succeeded', createdAt: YOUNG, idempotencyKey: 'key-young' });
    await run({ id: 'ev', state: 'succeeded', createdAt: YOUNG, eventId: 'ev-young' });
    await run({ id: 'tick', state: 'succeeded', createdAt: YOUNG, scheduledFor: YOUNG });
    // Old, with a newer scheduled row of the same job, so nothing protects it.
    await run({ id: 'k2', state: 'succeeded', createdAt: OLD, idempotencyKey: 'key-old' });

    await jobQueueRetentionService.purgeExpired({ now: NOW });
    expect(await runIds()).toEqual(['ev', 'k', 'tick']);

    const enqueue = (data: { idempotencyKey?: string; eventId?: string; scheduledFor?: Date }) =>
      withSystemContext((tx) =>
        jobQueueRepository.createIfAbsent(
          {
            jobId: 'test.retention',
            eventName: 'test/retention',
            runAt: NOW,
            maxAttempts: 3,
            ...data,
          },
          tx,
        ),
      );

    expect(await enqueue({ idempotencyKey: 'key-young' })).toBeNull();
    expect(await enqueue({ eventId: 'ev-young' })).toBeNull();
    expect(await enqueue({ scheduledFor: YOUNG })).toBeNull();
    expect(await adminDb.jobQueueRun.count({ where: { idempotencyKey: 'key-young' } })).toBe(1);

    // The documented horizon (foundation §17): past the window the key is free.
    expect(await enqueue({ idempotencyKey: 'key-old' })).not.toBeNull();
  });

  it('deletes an event only when it is old and no queue row of any state references it', async () => {
    await event('ev-orphan-old', OLD);
    await event('ev-young-run', OLD);
    await event('ev-failed-run', OLD);
    await event('ev-orphan-young', YOUNG);
    await event('ev-purged-run', OLD);
    await run({ id: 'young', state: 'succeeded', createdAt: YOUNG, eventId: 'ev-young-run' });
    await run({ id: 'failed', state: 'failed', createdAt: OLD, eventId: 'ev-failed-run' });
    await run({ id: 'purged', state: 'succeeded', createdAt: OLD, eventId: 'ev-purged-run' });

    const report = await jobQueueRetentionService.purgeExpired({ now: NOW });

    // The purged run's event goes in the SAME pass: phase 2 runs after phase 1.
    expect(report).toMatchObject({ jobQueue: 1, jobEvent: 2 });
    expect(await eventIds()).toEqual(['ev-failed-run', 'ev-orphan-young', 'ev-young-run']);
    expect(await runIds()).toEqual(['failed', 'young']);
  });

  it('bounds each invocation by batchSize and drains a backlog over several invocations', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = `bk-${String(i).padStart(2, '0')}`;
      ids.push(id);
      await run({
        id,
        state: 'succeeded',
        createdAt: new Date(OLD.getTime() - i * 1000),
        steps: 1,
      });
    }
    const opts = { now: NOW, batchSize: 10, maxBatches: 1 };

    const first = await jobQueueRetentionService.purgeExpired(opts);
    expect(first).toMatchObject({ jobQueue: 10, jobStep: 10, drained: false });
    // Oldest first: the ten oldest rows are the highest-numbered.
    expect(await runIds()).toEqual(ids.slice(0, 15));

    expect(await jobQueueRetentionService.purgeExpired(opts)).toMatchObject({ jobQueue: 10 });
    const last = await jobQueueRetentionService.purgeExpired(opts);
    expect(last).toMatchObject({ jobQueue: 5, drained: true });
    expect(await runIds()).toEqual([]);
  });

  it('bounds the event phase the same way, and a full pass drains it in one call', async () => {
    for (let i = 0; i < 25; i += 1) await event(`oe-${String(i).padStart(2, '0')}`, OLD);

    const first = await jobQueueRetentionService.purgeExpired({
      now: NOW,
      batchSize: 10,
      maxBatches: 1,
    });
    expect(first).toMatchObject({ jobEvent: 10, drained: false });
    expect(await eventIds()).toHaveLength(15);

    const full = await jobQueueRetentionService.purgeExpired({
      now: NOW,
      batchSize: 10,
      maxBatches: 100,
    });
    expect(full).toMatchObject({ jobEvent: 15, drained: true });
    expect(await eventIds()).toEqual([]);
  });

  it('never touches job_run or job_run_dlq, and a second pass deletes nothing', async () => {
    await run({ id: 'old', state: 'succeeded', createdAt: OLD });
    const ledger = await adminDb.jobRun.create({
      data: {
        functionId: 'test.retention',
        eventName: 'test/retention',
        eventId: 'old',
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        startedAt: OLD,
      },
    });
    const dlq = await adminDb.jobRunDlq.create({
      data: {
        functionId: 'test.retention',
        eventName: 'test/retention',
        eventData: {},
        failure: {},
        attempts: 3,
        firstFailedAt: OLD,
        lastFailedAt: OLD,
      },
    });

    await jobQueueRetentionService.purgeExpired({ now: NOW });
    const again = await jobQueueRetentionService.purgeExpired({ now: NOW });

    expect(again).toEqual({ jobQueue: 0, jobStep: 0, jobEvent: 0, batches: 2, drained: true });
    expect(await adminDb.jobRun.findUnique({ where: { id: ledger.id } })).not.toBeNull();
    expect(await adminDb.jobRunDlq.findUnique({ where: { id: dlq.id } })).not.toBeNull();
  });
});
