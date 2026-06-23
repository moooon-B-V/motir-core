import { type Organization, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Organization repository — single Prisma operations on the `organization`
// table (the root tenancy tier, Story 6.10). The org-scoped business logic
// (CRUD orchestration, the access gate, the signup auto-provision, the
// cross-workspace member roster) lives in `organizationsService` (6.10.4); this
// file is data access only — each method is one Prisma call, writes require
// `tx`. Mirrors `workspaceRepository`.

/** The two signals `pmTierForOrg` (8.1.11) resolves an org's §4 tier from: the
 *  `isMeta` exemption flag and the scaled-tracker subscription. */
export interface OrgCapContext {
  isMeta: boolean;
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}

/** Normalise a selected org row (or a missing/hidden one) into an `OrgCapContext`.
 *  Absent → the safe default (`isMeta: false`, no subscription → bounded `free`). */
function toCapContext(
  org: { isMeta: boolean; scaledTrackerSubscription: Prisma.JsonValue } | null,
): OrgCapContext {
  return {
    isMeta: org?.isMeta ?? false,
    scaledTrackerSubscription:
      (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null,
  };
}

export const organizationRepository = {
  async findById(id: string): Promise<Organization | null> {
    return db.organization.findUnique({ where: { id } });
  },

  async findBySlug(slug: string): Promise<Organization | null> {
    return db.organization.findUnique({ where: { slug } });
  },

  /**
   * Find by id inside the caller's transaction so the organization RLS policy
   * (which keys off the per-transaction `app.organization_id` / `app.user_id`
   * GUCs bound by the 6.10.4 org-context layer) admits the row under the
   * non-bypass `prodect_app` role. Used by role-gated reads that guard a
   * subsequent write; the `db`-singleton variant above returns NULL under RLS
   * when no context is bound.
   */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id } });
  },

  async create(
    data: { name: string; slug: string },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.create({ data });
  },

  async update(
    id: string,
    data: { name?: string; slug?: string; isMeta?: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data });
  },

  /**
   * Row-lock the organization `FOR UPDATE` inside the caller's transaction — the
   * serialization anchor for the §4 count-guarded creates (8.1.11). The work-item
   * / project / workspace caps read a count then create; without a shared lock
   * two concurrent creates both observe `count = limit - 1`, both pass, and both
   * insert (a warm-pool TOCTOU overage — CLAUDE.md § lock-before-read-derived).
   * Locking the single org row serializes every create under the org: the second
   * racer blocks until the first commits, then re-counts and correctly sees the
   * limit. Returns whether the row exists (false → the org was deleted/hidden).
   * `tx` REQUIRED — a row lock lives only for its transaction.
   */
  async lockByIdForUpdate(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "organization" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  /**
   * Read the org's §4 cap context (8.1.11) inside the caller's transaction — the
   * `isMeta` exemption flag + the scaled-tracker subscription, the two signals
   * `pmTierForOrg` resolves the tier from. A missing/hidden org collapses to
   * `{ isMeta: false, scaledTrackerSubscription: null }` (safe-by-default: the
   * bounded `free` tier, caps apply).
   */
  async findCapContextInTx(id: string, tx: Prisma.TransactionClient): Promise<OrgCapContext> {
    const org = await tx.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true },
    });
    return toCapContext(org);
  },

  /**
   * Read-only (db-singleton) variant of {@link findCapContextInTx} for the §4
   * upload path (8.1.11), which checks the per-file + total-storage caps as a
   * standalone read BEFORE the blob round-trip — no create transaction to thread.
   * Missing/hidden org → the safe default (bounded `free` tier, caps apply).
   */
  async findCapContext(id: string): Promise<OrgCapContext> {
    const org = await db.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true },
    });
    return toCapContext(org);
  },

  /**
   * Set (or clear) the org's scaled-tracker subscription state (8.1.4c). A
   * non-null `state` writes the propagated subscription JSON; `null` clears the
   * column to SQL NULL via `Prisma.DbNull` (the cancel path — non-destructive,
   * `billing-tiering.md` §4). Throws Prisma `P2025` when the org row is absent
   * or RLS-hidden; the service maps that to `OrganizationNotFoundError`. Must
   * run inside a tx whose `app.organization_id` GUC matches `id` (see
   * `withOrgServiceWriteContext`) so the `organization_mutate_active` RLS policy
   * admits the UPDATE under the non-bypass `prodect_app` role.
   */
  async updateScaledTrackerState(
    id: string,
    state: ScaledTrackerSubscription | null,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({
      where: { id },
      data: {
        scaledTrackerSubscription:
          state === null ? Prisma.DbNull : (state as unknown as Prisma.InputJsonValue),
      },
    });
  },
};
