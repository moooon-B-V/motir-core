import { type Organization, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Organization repository — single Prisma operations on the `organization`
// table (the root tenancy tier, Story 6.10). The org-scoped business logic
// (CRUD orchestration, the access gate, the signup auto-provision, the
// cross-workspace member roster) lives in `organizationsService` (6.10.4); this
// file is data access only — each method is one Prisma call, writes require
// `tx`. Mirrors `workspaceRepository`.

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
    data: { name?: string; slug?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data });
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
