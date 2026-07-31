import { randomUUID } from 'node:crypto';
import { Prisma, type CiPeriodCharge } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the per-period CI CHARGE row (Story MOTIR-1775 · MOTIR-1901) —
// the entitlement half's only durable state, and the row a charge LOCKS before
// deciding anything.
//
// Single-op methods only, per CLAUDE.md's 4-layer rule; every decision made from
// these values lives in `ciAllowanceService`.

/** The charge state a decision is made from — the locked row, as plain numbers. */
export interface CiPeriodChargeState {
  organizationId: string;
  periodStart: Date;
  /** Consumption already weighed against the pool (the watermark). */
  accountedMinutes: number;
  /** Of that, the minutes beyond the pool (fractional carry included). */
  chargedMinutes: number;
  /** Whole credits booked locally. */
  chargedCredits: number;
  /** Whole credits motir-ai's ledger has confirmed. */
  debitedCredits: number;
  /** An attempted-but-unconfirmed debit's idempotency key, or null. */
  pendingDebitRef: string | null;
  pendingDebitCredits: number;
}

function toState(row: CiPeriodCharge): CiPeriodChargeState {
  return {
    organizationId: row.organizationId,
    periodStart: row.periodStart,
    accountedMinutes: Number(row.accountedMinutes),
    chargedMinutes: Number(row.chargedMinutes),
    chargedCredits: row.chargedCredits,
    debitedCredits: row.debitedCredits,
    pendingDebitRef: row.pendingDebitRef,
    pendingDebitCredits: row.pendingDebitCredits,
  };
}

export const ciPeriodChargeRepository = {
  /**
   * Ensure the (org, period) row EXISTS, without disturbing it if it does.
   *
   * A `SELECT … FOR UPDATE` can only lock a row that is already there, and the
   * first metering event of a month finds none — so the lock would be a no-op
   * exactly when two concurrent first-runs race. This closes that window: one
   * atomic `INSERT … ON CONFLICT DO NOTHING`, so the loser of the insert race
   * simply finds the winner's row and the subsequent `FOR UPDATE` has something
   * to take.
   *
   * `DO NOTHING` rather than `DO UPDATE` on purpose: an upsert that touched the
   * counters would be a write, and this must be inert for an existing row.
   *
   * Two things raw SQL bypasses, both supplied explicitly (the same pair
   * `ciPeriodUsageRepository.incrementForPeriod` documents): `@updatedAt` (hence
   * the `NOW()`) and `@default(cuid())` — Prisma generates ids client-side, so
   * the INSERT binds one. A UUID rather than a cuid because no cuid generator
   * ships in this app's dependency set; the column is an opaque PK nothing joins
   * on by shape, and the model keeps its `cuid()` default for any Prisma-path
   * insert.
   */
  async ensureRow(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "ci_period_charge" (
        "id", "organization_id", "period_start", "created_at", "updated_at"
      )
      VALUES (${randomUUID()}, ${organizationId}, ${periodStart}, NOW(), NOW())
      ON CONFLICT ("organization_id", "period_start") DO NOTHING
    `;
  },

  /**
   * LOCK the (org, period) row `FOR UPDATE` and return it, re-read inside the
   * caller's transaction.
   *
   * ⚠️ This is the lock-before-read-derived-update rule (`notes.html` #35, the
   * CLAUDE.md 4-layer contract) applied to the one decision on this card that is
   * genuinely read-derived: *read consumption → read the balance → decide → debit*.
   * Without it, two runs completing at once both read the same watermark and both
   * charge the same minutes — a lost update that DOUBLE-BILLS a user, and one a
   * serial test cannot see. `tx` is REQUIRED because a row lock only lives for
   * its transaction.
   *
   * Its sibling `ciPeriodUsageRepository.incrementForPeriod` deliberately does
   * NOT lock, and the difference is the point: that one is a blind increment
   * (`ON CONFLICT DO UPDATE … + EXCLUDED`), not a decision made from a value that
   * must not change underneath it. This one is the decision.
   *
   * Returns null only when the row does not exist — call `ensureRow` first.
   */
  async lockForUpdate(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<CiPeriodChargeState | null> {
    const rows = await tx.$queryRaw<CiPeriodCharge[]>`
      SELECT
        "id",
        "organization_id"      AS "organizationId",
        "period_start"         AS "periodStart",
        "accounted_minutes"    AS "accountedMinutes",
        "charged_minutes"      AS "chargedMinutes",
        "charged_credits"      AS "chargedCredits",
        "debited_credits"      AS "debitedCredits",
        "pending_debit_ref"    AS "pendingDebitRef",
        "pending_debit_credits" AS "pendingDebitCredits",
        "created_at"           AS "createdAt",
        "updated_at"           AS "updatedAt"
      FROM "ci_period_charge"
      WHERE "organization_id" = ${organizationId} AND "period_start" = ${periodStart}
      FOR UPDATE
    `;
    const row = rows[0];
    return row ? toState(row) : null;
  },

  /** The un-locked read the billing panel + MOTIR-1907 use. Null before the
   *  org's first metered run of the period — the caller treats that as zeros. */
  async findForPeriod(
    organizationId: string,
    periodStart: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<CiPeriodChargeState | null> {
    const client = tx ?? db;
    const row = await client.ciPeriodCharge.findUnique({
      where: { organizationId_periodStart: { organizationId, periodStart } },
    });
    return row ? toState(row) : null;
  },

  /**
   * Record the outcome of one charge decision: advance the watermark, the charged
   * totals, and the pending-debit slot. Called only with the row LOCKED by
   * `lockForUpdate` in the same transaction, so these are absolute assignments
   * (the values the service computed from the locked state) rather than
   * increments — no second racer can have moved them in between.
   */
  async applyCharge(
    input: {
      organizationId: string;
      periodStart: Date;
      accountedMinutes: number;
      chargedMinutes: number;
      chargedCredits: number;
      pendingDebitRef: string | null;
      pendingDebitCredits: number;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciPeriodCharge.update({
      where: {
        organizationId_periodStart: {
          organizationId: input.organizationId,
          periodStart: input.periodStart,
        },
      },
      data: {
        accountedMinutes: new Prisma.Decimal(input.accountedMinutes),
        chargedMinutes: new Prisma.Decimal(input.chargedMinutes),
        chargedCredits: input.chargedCredits,
        pendingDebitRef: input.pendingDebitRef,
        pendingDebitCredits: input.pendingDebitCredits,
      },
    });
  },

  /**
   * Record an ATTEMPTED-but-unconfirmed debit: pin the confirmed watermark and
   * park the attempt's exact ref + amount so the next event replays it rather
   * than minting a new key for the same credits.
   *
   * Its own post-commit transaction, like `settleDebit` — it reports the outcome
   * of a cross-boundary call and must never be able to roll back the charge
   * decision that produced it.
   */
  async markPendingDebit(
    input: {
      organizationId: string;
      periodStart: Date;
      debitedCredits: number;
      pendingDebitRef: string;
      pendingDebitCredits: number;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciPeriodCharge.update({
      where: {
        organizationId_periodStart: {
          organizationId: input.organizationId,
          periodStart: input.periodStart,
        },
      },
      data: {
        debitedCredits: input.debitedCredits,
        pendingDebitRef: input.pendingDebitRef,
        pendingDebitCredits: input.pendingDebitCredits,
      },
    });
  },

  /**
   * Settle a cross-boundary debit AFTER motir-ai confirmed it: advance the
   * confirmed watermark and clear the pending slot.
   *
   * Its own transaction, deliberately — this runs POST-COMMIT (§8.6), so it must
   * never be able to roll back the charge decision that produced it. `FOR UPDATE`
   * again because a concurrent metering event may be reading the same row to
   * decide whether a debit is still outstanding.
   */
  async settleDebit(
    input: { organizationId: string; periodStart: Date; debitedCredits: number },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciPeriodCharge.update({
      where: {
        organizationId_periodStart: {
          organizationId: input.organizationId,
          periodStart: input.periodStart,
        },
      },
      data: {
        debitedCredits: input.debitedCredits,
        pendingDebitRef: null,
        pendingDebitCredits: 0,
      },
    });
  },
};
