import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The fleet org CI setting's PUBLIC read arm (Story MOTIR-8699 · MOTIR-8714) —
 * the evidence `singleton-read-guard.test.ts`'s `public` verdict cites.
 *
 * The console reads the setting row outside any platform transaction (opening
 * one writes an audit row), so it relies on the table's SELECT policy admitting
 * the row with nothing bound. The arm must be read-only: a write with nothing
 * bound is refused, because `app.platform_staff` is what the write arm needs.
 */

async function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    // RLS is inert under the superuser (BYPASSRLS); the role switch is what
    // makes these assertions mean anything.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the fleet org CI state read', () => {
  it('ADMITS the row with nothing bound', async () => {
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.project.id, org: 'acme', enabled: true, lastReason: 'try it' },
    });
    const row = await asAppRole((tx) =>
      tx.platformFleetOrgCi.findUnique({
        where: { projectId_org: { projectId: fx.project.id, org: 'acme' } },
        select: { enabled: true, lastReason: true },
      }),
    );
    expect(row).toEqual({ enabled: true, lastReason: 'try it' });
  });

  it('REFUSES a write with nothing bound — the arm is read-only', async () => {
    await expect(
      asAppRole((tx) =>
        tx.platformFleetOrgCi.create({
          data: { projectId: fx.project.id, org: 'acme', enabled: true },
        }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.platformFleetOrgCi.count()).toBe(0);
  });
});
