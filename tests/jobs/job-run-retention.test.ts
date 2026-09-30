import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobRunStatus, Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { JOB_RUN_RETENTION_MS, jobRunsService } from '@/lib/services/jobRunsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';

// Bug MOTIR-6935 — NOTHING EVER DELETED A `job_run` ROW.
//
// The abandoned-run reap closes rows and removes none, and the untenanted
// `system.*` rows are out of reach of a workspace deletion's cascade, so the
// ledger grew for ever — ~3,168 rows a day from the 5-minute sweeps alone. The
// retention pass deletes terminal rows past a window, in bounded batches, and
// these tests seed rows either side of that window and read back which survive.

const NOW = new Date('2026-09-29T06:00:00Z');
const OLD = new Date(NOW.getTime() - JOB_RUN_RETENTION_MS - 24 * 60 * 60 * 1000);
const OLDER = new Date(OLD.getTime() - 60 * 60 * 1000);
const YOUNG = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function seed(opts: {
  status: JobRunStatus;
  startedAt: Date;
  functionId?: string;
  eventName?: string;
  eventId?: string;
  workspaceId?: string | null;
  output?: Prisma.InputJsonValue;
}): Promise<string> {
  seq += 1;
  const functionId = opts.functionId ?? `system.retention-${seq}`;
  const row = await adminDb.jobRun.create({
    data: {
      workspaceId: opts.workspaceId ?? null,
      functionId,
      eventName: opts.eventName ?? `scheduled.${functionId}`,
      eventId: opts.eventId ?? `retention-event-${seq}`,
      lane: 'engine',
      attempt: 0,
      status: opts.status,
      startedAt: opts.startedAt,
      output: opts.output,
    },
  });
  return row.id;
}

async function surviving(): Promise<Set<string>> {
  const rows = await adminDb.jobRun.findMany({ select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

describe('the job_run retention pass', () => {
  it('deletes terminal rows older than the window and keeps everything younger', async () => {
    // One job with a young run, so its old runs are not the newest of their event
    // name (that row is kept for the schedule-health read — see below).
    const fn = 'system.retention-sweep';
    const oldSucceeded = await seed({ functionId: fn, status: 'succeeded', startedAt: OLDER });
    const oldFailed = await seed({ functionId: fn, status: 'failed', startedAt: OLDER });
    const oldAbandoned = await seed({ functionId: fn, status: 'abandoned', startedAt: OLD });
    const youngSucceeded = await seed({ functionId: fn, status: 'succeeded', startedAt: YOUNG });
    const youngFailed = await seed({ functionId: fn, status: 'failed', startedAt: YOUNG });

    const outcome = await jobRunsService.purgeExpired({ now: NOW });

    expect(outcome.deleted).toBe(3);
    expect(outcome.drained).toBe(true);
    const left = await surviving();
    expect(left.has(oldSucceeded)).toBe(false);
    expect(left.has(oldFailed)).toBe(false);
    expect(left.has(oldAbandoned)).toBe(false);
    expect(left.has(youngSucceeded)).toBe(true);
    expect(left.has(youngFailed)).toBe(true);
  });

  it('never deletes a `running` row, however old', async () => {
    const fn = 'system.retention-running';
    const running = await seed({ functionId: fn, status: 'running', startedAt: OLDER });
    await seed({ functionId: fn, status: 'succeeded', startedAt: YOUNG });

    await jobRunsService.purgeExpired({ now: NOW });

    expect((await surviving()).has(running)).toBe(true);
  });

  it('never deletes a row whose queue run is still live', async () => {
    const fn = 'system.retention-live';
    // A retried run: its first attempt failed long ago and the queue row is
    // still pending. The engine correlates a cron's ledger row to the QUEUE
    // ROW's id, so that is the join exercised here.
    const queued = await adminDb.jobQueueRun.create({
      data: {
        jobId: fn,
        eventName: `scheduled.${fn}`,
        runAt: new Date(NOW.getTime() + 3_600_000),
        maxAttempts: 3,
        state: 'pending',
      },
    });
    const attempt = await seed({
      functionId: fn,
      status: 'failed',
      startedAt: OLDER,
      eventId: queued.id,
    });
    const settled = await seed({ functionId: fn, status: 'failed', startedAt: OLDER });
    await seed({ functionId: fn, status: 'succeeded', startedAt: YOUNG });

    await jobRunsService.purgeExpired({ now: NOW });

    const left = await surviving();
    expect(left.has(attempt)).toBe(true);
    expect(left.has(settled)).toBe(false);
  });

  it('keeps the newest row of each event name, so a job that stopped firing still reads as having run', async () => {
    // The schedule-health check reads "when did this job last run?". A job whose
    // only runs are older than the window must keep its newest one, or the check
    // would report it as never having run.
    const fn = 'system.retention-stopped';
    const older = await seed({ functionId: fn, status: 'succeeded', startedAt: OLDER });
    const newest = await seed({ functionId: fn, status: 'succeeded', startedAt: OLD });

    await jobRunsService.purgeExpired({ now: NOW });

    const left = await surviving();
    expect(left.has(newest)).toBe(true);
    expect(left.has(older)).toBe(false);
  });

  it('keeps the newest succeeded code-graph run per repository, whatever its age', async () => {
    const owner = await usersService.createUser({
      email: 'retention@example.com',
      password: 'correct-horse-battery',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const fn = 'system.code-graph-index';
    const index = (
      startedAt: Date,
      output: Prisma.InputJsonValue,
      status: JobRunStatus = 'succeeded',
    ) => seed({ functionId: fn, workspaceId: workspace.id, status, startedAt, output });

    const apiOlder = await index(OLDER, { indexed: true, repoRef: 'acme/api' });
    const apiNewest = await index(OLD, { indexed: true, repoRef: 'acme/api' });
    const webOnly = await index(OLDER, { indexed: true, repoRef: 'acme/web' });
    const indexedNothing = await index(OLDER, { indexed: false, reason: 'empty' });
    // A younger FAILED run makes none of the above the newest of its event name,
    // so what keeps them is the code-graph rule, not the event-name one.
    await index(YOUNG, {}, 'failed');

    await jobRunsService.purgeExpired({ now: NOW });

    const left = await surviving();
    expect(left.has(apiNewest)).toBe(true);
    expect(left.has(webOnly)).toBe(true);
    expect(left.has(apiOlder)).toBe(false);
    expect(left.has(indexedNothing)).toBe(false);
  });

  it("keeps a terminal run a repository's `indexing_run_id` points at", async () => {
    // `deriveRefreshFailing` reads a terminal run under that pointer as "this
    // repository's refresh is dead"; deleting the row would clear the warning.
    const owner = await usersService.createUser({
      email: 'pointer@example.com',
      password: 'correct-horse-battery',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const fn = 'system.code-graph-refresh';
    const dead = await seed({
      functionId: fn,
      workspaceId: workspace.id,
      status: 'failed',
      startedAt: OLDER,
    });
    const unpointed = await seed({
      functionId: fn,
      workspaceId: workspace.id,
      status: 'failed',
      startedAt: OLDER,
    });
    await seed({ functionId: fn, workspaceId: workspace.id, status: 'failed', startedAt: YOUNG });

    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${workspace.id}`,
        workspaceId: workspace.id,
        accountLogin: 'acme',
        accountType: 'User',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: workspace.id,
        organizationId: await organizationIdOf(workspace.id),
        repoId: 'r1',
        owner: 'acme',
        name: 'api',
        defaultBranch: 'main',
        indexingRunId: dead,
      },
    });

    await jobRunsService.purgeExpired({ now: NOW });

    const left = await surviving();
    expect(left.has(dead)).toBe(true);
    expect(left.has(unpointed)).toBe(false);
  });

  it('deletes in bounded batches and drains a backlog over several passes', async () => {
    const fn = 'system.retention-backlog';
    for (let i = 0; i < 5; i += 1) {
      await seed({ functionId: fn, status: 'succeeded', startedAt: OLDER });
    }
    await seed({ functionId: fn, status: 'succeeded', startedAt: YOUNG });

    const first = await jobRunsService.purgeExpired({ now: NOW, batchSize: 2, maxBatches: 2 });
    expect(first).toMatchObject({ deleted: 4, batches: 2, drained: false });

    const second = await jobRunsService.purgeExpired({ now: NOW, batchSize: 2, maxBatches: 2 });
    expect(second).toMatchObject({ deleted: 1, batches: 1, drained: true });

    expect((await surviving()).size).toBe(1);
  });
});
