import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { trackRequestedTransactions } from '../helpers/requestedTransactions';
import { truncateAuthTables } from '../helpers/db';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// MOTIR-6627 — Sentry `PrismaClientKnownRequestError: Transaction API error: Unable
// to start a transaction in the given time.` on `GET /api/public/p/[identifier]`,
// at `computeStats` (`publicProjectsService.ts:214`).
//
// That message is Prisma's `maxWait` (2 s) expiring while ACQUIRING a pooled
// connection — not a slow transaction. `getOverview` opened THREE interactive
// transactions at once (the workspace read, and `computeStats`' two bound counts,
// each its own `withWorkspaceServiceContext`), so one anonymous page render held
// three pool slots for its bound reads alone. A few concurrent renders of the
// public page drain the pool and the next `$transaction` times out.
//
// The three reads share ONE binding — the project's own workspace — so the
// fan-out was never the structural exception `lib/workspaces/context.ts` allows
// this service (a mix of bound and deliberately UNBOUND reads). They belong in
// one transaction, per `docs/decisions/bound-read-transaction-shape.md`.

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
  await setProjectAccess(adminDb, fx.projectId, 'public');
  return fx;
}

describe('publicProjectsService.getOverview — pool slots per render (MOTIR-6627)', () => {
  it('holds at most ONE interactive transaction open at a time', async () => {
    const fx = await makePublicProjectFixture();
    const tracker = trackRequestedTransactions();

    await publicProjectsService.getOverview(fx.projectIdentifier, null);

    expect(tracker.peak()).toBe(1);
  });

  it('still reports the stat strip and the workspace name', async () => {
    const fx = await makePublicProjectFixture();
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.workspaceName).toBe('Acme');
    expect(overview.stats).toMatchObject({ publicRequests: 0, upvotes: 0 });
  });
});
