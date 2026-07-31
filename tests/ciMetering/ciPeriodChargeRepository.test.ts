import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { truncateAuthTables } from '../helpers/db';

// The charge row's data access in isolation (Story MOTIR-1775 · MOTIR-1901) —
// the row-level behaviours `ciAllowanceService`'s tests exercise only indirectly:
// the ensure-then-lock pair that makes a first-of-the-month race safe, and the
// singleton-vs-transaction read the billing panel will use.

const PERIOD = new Date('2026-07-01T00:00:00.000Z');

async function seedOrgId(): Promise<string> {
  const suffix = Math.floor(Math.random() * 1_000_000);
  const owner = await usersService.createUser({
    email: `charge-repo-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: owner.id,
  });
  return workspace.organizationId;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('ensureRow + lockForUpdate', () => {
  it('lockForUpdate returns null before the row exists', async () => {
    const organizationId = await seedOrgId();
    const locked = await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.lockForUpdate(organizationId, PERIOD, tx),
    );
    // A `SELECT … FOR UPDATE` cannot lock a row that is not there — which is why
    // `ensureRow` has to run first, and why the service never calls this alone.
    expect(locked).toBeNull();
  });

  it('ensureRow creates the row once and is INERT on the second call', async () => {
    const organizationId = await seedOrgId();

    await withOrgServiceWriteContext(organizationId, async (tx) => {
      await ciPeriodChargeRepository.ensureRow(organizationId, PERIOD, tx);
      await ciPeriodChargeRepository.applyCharge(
        {
          organizationId,
          periodStart: PERIOD,
          accountedMinutes: 1500,
          chargedMinutes: 500,
          chargedCredits: 500,
          pendingDebitRef: null,
          pendingDebitCredits: 0,
        },
        tx,
      );
    });

    // `ON CONFLICT DO NOTHING`, deliberately — a second ensure must not reset the
    // counters it finds. `DO UPDATE` here would silently zero a period's charges.
    await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.ensureRow(organizationId, PERIOD, tx),
    );

    const row = await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.lockForUpdate(organizationId, PERIOD, tx),
    );
    expect(row).toMatchObject({
      accountedMinutes: 1500,
      chargedMinutes: 500,
      chargedCredits: 500,
      debitedCredits: 0,
      pendingDebitRef: null,
      pendingDebitCredits: 0,
    });
    expect(await db.ciPeriodCharge.count()).toBe(1);
  });

  it('two concurrent ensureRow calls settle on ONE row', async () => {
    const organizationId = await seedOrgId();
    // The first-of-the-month race the ensure exists for: both callers find no row.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withOrgServiceWriteContext(organizationId, (tx) =>
          ciPeriodChargeRepository.ensureRow(organizationId, PERIOD, tx),
        ),
      ),
    );
    expect(await db.ciPeriodCharge.count()).toBe(1);
  });
});

describe('findForPeriod', () => {
  it('reads through the db SINGLETON when given no transaction', async () => {
    const organizationId = await seedOrgId();
    await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.ensureRow(organizationId, PERIOD, tx),
    );

    // The un-scoped read path (the billing panel's, MOTIR-1903) — no tx argument.
    const row = await ciPeriodChargeRepository.findForPeriod(organizationId, PERIOD);
    expect(row).toMatchObject({ organizationId, chargedCredits: 0 });
  });

  it('returns null for a period the org has never metered', async () => {
    const organizationId = await seedOrgId();
    expect(
      await ciPeriodChargeRepository.findForPeriod(
        organizationId,
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('markPendingDebit / settleDebit', () => {
  it('parks an unconfirmed attempt, then clears it on settle', async () => {
    const organizationId = await seedOrgId();
    await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.ensureRow(organizationId, PERIOD, tx),
    );

    await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.markPendingDebit(
        {
          organizationId,
          periodStart: PERIOD,
          debitedCredits: 0,
          pendingDebitRef: 'org:2026-07:0-150',
          pendingDebitCredits: 150,
        },
        tx,
      ),
    );
    expect(await ciPeriodChargeRepository.findForPeriod(organizationId, PERIOD)).toMatchObject({
      pendingDebitRef: 'org:2026-07:0-150',
      pendingDebitCredits: 150,
      debitedCredits: 0,
    });

    await withOrgServiceWriteContext(organizationId, (tx) =>
      ciPeriodChargeRepository.settleDebit(
        { organizationId, periodStart: PERIOD, debitedCredits: 150 },
        tx,
      ),
    );
    expect(await ciPeriodChargeRepository.findForPeriod(organizationId, PERIOD)).toMatchObject({
      pendingDebitRef: null,
      pendingDebitCredits: 0,
      debitedCredits: 150,
    });
  });
});
