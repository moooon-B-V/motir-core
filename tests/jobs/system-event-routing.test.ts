import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { sendSystemEvent } from '@/lib/jobs/sendEvent';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
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

// ⚠️ THIS FILE ASKED WHETHER A SWITCH REACHED A SYSTEM EVENT (MOTIR-3418 removed
// the switch). `system.billing-seat-sync` was the ONE of the four converted
// `system.*` events MOTIR-3456 was entitled to move — the other three being the
// container supervisors MOTIR-3417 owned — so it asserted three things: the id in
// the routing set enqueued, the id absent enqueued NOTHING, and the three
// supervisors stayed unrouted "even so".
//
// Two of those three named a lane a job could stay on. What survives is the half
// that was never about the migration and is the reason MOTIR-3456 exists at all:
// **an emitter that goes through `sendSystemEvent` reaches the queue, and one
// that bypasses it does not.** Four `system.*` emitters used to bypass it.

const SEAT_SYNC = 'system.billing-seat-sync';

let seq = 0;
/** A REAL workspace — `job_event.workspace_id` carries an FK, so a synthetic id
 *  is refused at the insert and the emit is swallowed by the best-effort arm. */
async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `sys-routing-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Sys Routing ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Sys Routing WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the system-event door reaches the queue', () => {
  it('ENQUEUES a job_queue row for the seat-sync event', async () => {
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

  it('ENQUEUES the supervisor events through the same door', async () => {
    // ⚠️ INVERTED FROM WHAT IT ASSERTED (MOTIR-3418). This used to be "leaves the
    // three SUPERVISOR events unrouted even so", because reachable was not moved:
    // MOTIR-3456 made all four switchable and only one of them was that story's
    // to switch. All four moved (MOTIR-3489), and there is nowhere left to be
    // unrouted to — so the assertion is that the door carries them, which is the
    // property MOTIR-3456 actually shipped.
    await sendSystemEvent('system.code-graph-index', {
      installationId: 'inst_1',
      workspaceId: await makeWorkspace(),
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    });

    expect(
      await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.code-graph-index' } }),
    ).toHaveLength(1);
  });
});
