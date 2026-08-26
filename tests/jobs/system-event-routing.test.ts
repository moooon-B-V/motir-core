import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JOB_ENGINE_JOBS_ENV } from '@/lib/jobs/engine/cutover';
import { sendSystemEvent } from '@/lib/jobs/sendEvent';
// The REAL registry, for its side effect — every definition module evaluated, so
// `engineSubscribers('system.billing-seat-sync')` resolves the real job.
//
// ⚠️ THIS IMPORT IS LOAD-BEARING HERE AND IS *NOT* THE ONE MOTIR-3458 IS ABOUT.
// That card's guard proves the emit path resolves subscribers WITHOUT this
// import, from a fresh module graph, because relying on it is the defect. This
// file asks a different question — given a complete registry, does the routing
// set move `system.billing-seat-sync` onto the engine — so it is entitled to
// make the registry complete the cheapest way.
import '@/lib/jobs/registry';

// `system.billing-seat-sync` is the ONE of the four converted `system.*` events
// this story is entitled to move (MOTIR-3456's scope boundary): the other three
// are the container supervisors, which MOTIR-3417 owns. Making a switch
// reachable is not throwing it — so this proves the switch WORKS for it, while
// `MOTIR_POSTGRES_JOB_IDS` ships untouched.

const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];
const SEAT_SYNC = 'system.billing-seat-sync';

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  delete process.env[JOB_ENGINE_JOBS_ENV];
});

afterEach(async () => {
  await truncateJobRuns();
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the cutover switch now reaches a system event', () => {
  it('ENQUEUES a job_queue row when the seat-sync id is in the routing set', async () => {
    process.env[JOB_ENGINE_JOBS_ENV] = SEAT_SYNC;

    await sendSystemEvent(SEAT_SYNC, { organizationId: 'org_routing_1' });

    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: SEAT_SYNC } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventName).toBe(SEAT_SYNC);
    // A system event is untenanted — the row carries a null workspace, which is
    // the shape `system.ci-runner-reap` already lands on the ledger.
    expect(rows[0]!.workspaceId).toBeNull();

    const events = await adminDb.jobEvent.findMany({ where: { name: SEAT_SYNC } });
    expect(events).toHaveLength(1);
  });

  it('ENQUEUES NOTHING when the id is absent — the default is still Inngest', async () => {
    delete process.env[JOB_ENGINE_JOBS_ENV];

    await sendSystemEvent(SEAT_SYNC, { organizationId: 'org_routing_2' });

    expect(await adminDb.jobQueueRun.findMany({ where: { jobId: SEAT_SYNC } })).toHaveLength(0);
    // Not even a job_event row: writing one anyway would fill the table with
    // events nothing will ever consume, for the whole migration.
    expect(await adminDb.jobEvent.findMany({ where: { name: SEAT_SYNC } })).toHaveLength(0);
  });

  it('leaves the three SUPERVISOR events unrouted even so — MOTIR-3417 moves those', async () => {
    // Reachable is not moved. The seam this card ships makes all four
    // switchable; only one of them is this story's to switch.
    process.env[JOB_ENGINE_JOBS_ENV] = SEAT_SYNC;

    await sendSystemEvent('system.code-graph-index', {
      installationId: 'inst_1',
      workspaceId: 'ws_unrouted',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    });

    expect(
      await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.code-graph-index' } }),
    ).toHaveLength(0);
  });
});
