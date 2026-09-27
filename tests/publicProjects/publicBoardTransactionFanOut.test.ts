import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { trackRequestedTransactions } from '../helpers/requestedTransactions';

// MOTIR-6653 — the public BOARD read had the shape MOTIR-6627 removed from the
// overview. After the default-board lookup, `getBoard` ran three peer reads on
// `Promise.all`, and each opened its own interactive transaction: the column read,
// the column-status read, and `workflowsService.listStatusesByProject`. One
// anonymous render asked the pool (pg's default, 10) for three slots at once, and
// a handful of concurrent renders drain it until the next `$transaction` dies at
// Prisma's 2 s `maxWait` — "Unable to start a transaction in the given time".
//
// All three share ONE binding (the project's own workspace), so they belong in one
// transaction per `docs/decisions/bound-read-transaction-shape.md`.
//
// The second half is `listStatusesByProject` itself: handed a `tx`, it still
// opened a transaction of its own and ran the query on the caller's. The caller
// holds one slot and waits on a second, idle one — every caller that threads a
// `tx` into it paid the double slot.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makePublicProjectFixture(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name: 'Acme' });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

describe('publicProjectsService.getBoard — pool slots per render (MOTIR-6653)', () => {
  it('holds at most ONE interactive transaction open at a time', async () => {
    const fx = await makePublicProjectFixture();
    const tracker = trackRequestedTransactions();

    await publicProjectsService.getBoard(fx.projectIdentifier, null);

    expect(tracker.peak()).toBe(1);
  });

  it('still projects the default board with its mapped columns', async () => {
    const fx = await makePublicProjectFixture();
    const board = await publicProjectsService.getBoard(fx.projectIdentifier, null);
    expect(board.boardId).not.toBe('');
    expect(board.columns.length).toBeGreaterThan(0);
    // Every column's statuses resolved against the live workflow — the status
    // read ran on the same transaction as the mapping read, not on an empty one.
    expect(board.columns.some((c) => c.statusKeys.length > 0)).toBe(true);
  });
});

describe('workflowsService.listStatusesByProject — a threaded tx (MOTIR-6653)', () => {
  it('opens NO transaction of its own when the caller passes one', async () => {
    const fx = await makePublicProjectFixture();
    const tracker = trackRequestedTransactions();

    const statuses = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId, tx),
    );

    expect(statuses.length).toBeGreaterThan(0);
    // The caller's own transaction, and nothing else.
    expect(tracker.total()).toBe(1);
  });

  it('still binds a transaction of its own when called without one', async () => {
    const fx = await makePublicProjectFixture();
    const tracker = trackRequestedTransactions();

    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);

    expect(statuses.length).toBeGreaterThan(0);
    expect(tracker.total()).toBe(1);
  });
});
