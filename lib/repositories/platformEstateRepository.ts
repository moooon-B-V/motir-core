import { type Prisma } from '@/generated/prisma/client';

/**
 * Cross-tenant ESTATE access for the operator console — the platform tier's
 * repository for the tiers beneath an organization (`docs/decisions/platform-staff-auth.md`
 * §3, Story MOTIR-727 · MOTIR-730).
 *
 * The sibling of `platformOrganizationRepository` and `platformUserRepository`,
 * and it follows their rules rather than restating them:
 *
 * ⚠️ EVERY METHOD TAKES `tx` AS A REQUIRED PARAMETER, READS INCLUDED. The only
 * thing that opens a platform transaction is `withPlatformRead`, and opening one
 * is what writes the audit row — so requiring `tx` makes an untrailed
 * cross-tenant read a compile error rather than a review finding.
 *
 * ⚠️ THE TABLES IT READS HAVE RLS, and `20261001200000_platform_staff_estate_read_arms`
 * is what makes these methods answer. `workspace`, `project`,
 * `workspace_membership` and `organization_membership` all run FORCE ROW LEVEL
 * SECURITY; their `platform_staff` SELECT arms are the only policies that admit
 * a read with no tenant GUC bound. On the `db` singleton every method here
 * returns zero — a count of 0, an empty list — and raises nothing.
 *
 * ⚠️ NO TENANT FILTER, deliberately. A count here is the whole estate's, and that
 * absence is the thing being reviewed rather than a bug to be caught (§3's layer
 * table). What confines these methods is that they are reachable only from
 * `lib/services/platform*Service.ts`, each of whose public methods takes a
 * `PlatformPrincipal` and re-asserts the degree ladder.
 *
 * ⚠️ READS ONLY. The ADR gives no tenant table a `platform_staff` write arm, so a
 * mutator here would be refused by the database — and must not be "fixed" by
 * adding one.
 */
export const platformEstateRepository = {
  /** Every organization Motir hosts — one `count(*)`, never a row load. */
  async countOrganizations(tx: Prisma.TransactionClient): Promise<number> {
    return tx.organization.count();
  },

  /** Every workspace, across every organization. */
  async countWorkspaces(tx: Prisma.TransactionClient): Promise<number> {
    return tx.workspace.count();
  },

  /** Every project, across every workspace. */
  async countProjects(tx: Prisma.TransactionClient): Promise<number> {
    return tx.project.count();
  },

  /**
   * Every account. `user` carries no RLS (the global identity —
   * `tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED map), so this
   * one would answer without an arm; it lives here so the four estate counts are
   * read in one place and one audited transaction.
   */
  async countUsers(tx: Prisma.TransactionClient): Promise<number> {
    return tx.user.count();
  },

  /**
   * One organization's workspaces, oldest first, each with its project and
   * member counts — one query (Prisma's `_count` is a correlated subselect, not
   * a row load of either relation).
   *
   * `take` is the caller's cap. The service asks for one more than it shows so
   * it can say "there are more" without a second count.
   */
  async listWorkspacesForOrganization(
    organizationId: string,
    take: number,
    tx: Prisma.TransactionClient,
  ) {
    return tx.workspace.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { projects: true, memberships: true } },
      },
    });
  },

  /** How many accounts hold a membership of one organization. */
  async countOrganizationMembers(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.organizationMembership.count({ where: { organizationId } });
  },
};

/** One row of `listWorkspacesForOrganization`. */
export type PlatformWorkspaceRow = Awaited<
  ReturnType<typeof platformEstateRepository.listWorkspacesForOrganization>
>[number];
