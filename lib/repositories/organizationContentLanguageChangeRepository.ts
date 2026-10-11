import type { OrganizationContentLanguageChange, Prisma } from '@/generated/prisma/client';

// The attributed history of an organisation's content language (Story
// MOTIR-7731 · MOTIR-8094) — who changed it, from what, to what and when. Single
// Prisma operations on `organization_content_language_change`; every method
// takes the caller's transaction, because the table is under forced RLS scoped
// to `app.organization_id`, which only an org context binds.

export interface OrganizationContentLanguageChangeInsert {
  organizationId: string;
  changedByUserId: string;
  fromLanguage: string;
  toLanguage: string;
}

export const organizationContentLanguageChangeRepository = {
  async insert(
    data: OrganizationContentLanguageChangeInsert,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationContentLanguageChange> {
    return tx.organizationContentLanguageChange.create({ data });
  },

  /** Newest first; `id` breaks a tie between two changes in the same instant. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationContentLanguageChange[]> {
    return tx.organizationContentLanguageChange.findMany({
      where: { organizationId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The newest change, or null when the language was never changed. */
  async findLatestByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationContentLanguageChange | null> {
    return tx.organizationContentLanguageChange.findFirst({
      where: { organizationId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Every row of the organisation — the erasure tombstone's step. The org row
   * survives erasure (it carries the billing record), so its cascade never
   * fires and the history, which names people, has to be removed explicitly.
   */
  async deleteAllByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.organizationContentLanguageChange.deleteMany({ where: { organizationId } });
    return r.count;
  },
};
