import { Prisma } from '@/generated/prisma/client';

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

  /**
   * One keyset page of an organization's MEMBERS (MOTIR-733), oldest first on
   * `(createdAt, id)` — the person, their organization role and when they joined.
   */
  async listOrganizationMembers(
    organizationId: string,
    input: { take: number; after: { at: Date; id: string } | null },
    tx: Prisma.TransactionClient,
  ) {
    return tx.organizationMembership.findMany({
      where: {
        organizationId,
        ...(input.after
          ? {
              OR: [
                { createdAt: { gt: input.after.at } },
                { createdAt: input.after.at, id: { gt: input.after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.take,
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
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

  /**
   * How many of each tier were CREATED since `since` — the overview's period
   * deltas (MOTIR-731). One statement of four indexed `count(*)`s, never a row load.
   */
  async countCreatedSince(
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<{ organizations: number; workspaces: number; projects: number; users: number }> {
    const rows = await tx.$queryRaw<
      { organizations: bigint; workspaces: bigint; projects: bigint; users: bigint }[]
    >`
      SELECT (SELECT count(*) FROM "organization" WHERE "createdAt" >= ${since}) AS organizations,
             (SELECT count(*) FROM "workspace" WHERE "createdAt" >= ${since}) AS workspaces,
             (SELECT count(*) FROM "project" WHERE "createdAt" >= ${since}) AS projects,
             (SELECT count(*) FROM "user" WHERE "createdAt" >= ${since}) AS users`;
    const r = rows[0] as {
      organizations: bigint;
      workspaces: bigint;
      projects: bigint;
      users: bigint;
    };
    return {
      organizations: Number(r.organizations),
      workspaces: Number(r.workspaces),
      projects: Number(r.projects),
      users: Number(r.users),
    };
  },

  /**
   * The newest TENANT EVENTS — organizations, workspaces and projects created —
   * across the estate, newest first under one keyset on `(createdAt, id)`
   * (MOTIR-731). Each branch is LIMITed before the merge, so a page reads at most
   * `take` rows per table through its `createdAt` order, never a table.
   *
   * Each row carries its tenant path's names and, where the estate records one,
   * who it belongs to: an organization's first owner, a workspace's first manager.
   * A project records no creator, so its detail is its key.
   */
  async listTenantEvents(
    input: { take: number; before: { at: Date; id: string } | null },
    tx: Prisma.TransactionClient,
  ): Promise<PlatformTenantEventRow[]> {
    const older = (alias: string) =>
      input.before
        ? Prisma.sql`WHERE (${Prisma.raw(alias)}."createdAt", ${Prisma.raw(alias)}."id") < (${input.before.at}, ${input.before.id})`
        : Prisma.empty;
    return tx.$queryRaw<PlatformTenantEventRow[]>`
      SELECT * FROM (
        (SELECT 'organization'::text AS "kind", o."id", o."createdAt" AS "at",
                o."id" AS "organizationId", o."name" AS "organizationName",
                NULL::text AS "workspaceId", NULL::text AS "workspaceName",
                NULL::text AS "projectName",
                (SELECT u."email" FROM "organization_membership" m JOIN "user" u ON u."id" = m."userId"
                  WHERE m."organizationId" = o."id" AND m."role" = 'owner'
                  ORDER BY m."createdAt" ASC LIMIT 1) AS "detail"
         FROM "organization" o ${older('o')}
         ORDER BY o."createdAt" DESC, o."id" DESC LIMIT ${input.take})
        UNION ALL
        (SELECT 'workspace'::text, w."id", w."createdAt", o."id", o."name", w."id", w."name", NULL::text,
                (SELECT u."email" FROM "workspace_membership" m JOIN "user" u ON u."id" = m."userId"
                  WHERE m."workspaceId" = w."id" AND m."workspace_role" = 'manager'
                  ORDER BY m."createdAt" ASC LIMIT 1)
         FROM "workspace" w JOIN "organization" o ON o."id" = w."organizationId" ${older('w')}
         ORDER BY w."createdAt" DESC, w."id" DESC LIMIT ${input.take})
        UNION ALL
        (SELECT 'project'::text, p."id", p."createdAt", o."id", o."name", w."id", w."name", p."name",
                p."identifier"
         FROM "project" p JOIN "workspace" w ON w."id" = p."workspaceId"
         JOIN "organization" o ON o."id" = w."organizationId" ${older('p')}
         ORDER BY p."createdAt" DESC, p."id" DESC LIMIT ${input.take})
      ) e
      ORDER BY e."at" DESC, e."id" DESC
      LIMIT ${input.take}`;
  },

  /**
   * The names behind core ids a remote read returned (the runs slice's org,
   * workspace and project ids), so a page can label them — one statement.
   */
  async findTenantNames(
    ids: { organizationIds: string[]; workspaceIds: string[]; projectIds: string[] },
    tx: Prisma.TransactionClient,
  ): Promise<{ kind: 'organization' | 'workspace' | 'project'; id: string; name: string }[]> {
    const list = (values: string[]) => (values.length ? Prisma.join(values) : Prisma.sql`NULL`);
    return tx.$queryRaw`
      SELECT 'organization'::text AS "kind", "id", "name" FROM "organization" WHERE "id" IN (${list(ids.organizationIds)})
      UNION ALL
      SELECT 'workspace'::text, "id", "name" FROM "workspace" WHERE "id" IN (${list(ids.workspaceIds)})
      UNION ALL
      SELECT 'project'::text, "id", "name" FROM "project" WHERE "id" IN (${list(ids.projectIds)})`;
  },
};

/** One row of `listTenantEvents`. */
export interface PlatformTenantEventRow {
  kind: 'organization' | 'workspace' | 'project';
  id: string;
  at: Date;
  organizationId: string;
  organizationName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  projectName: string | null;
  /** The owner's / manager's email, or a project's key. Null when none is recorded. */
  detail: string | null;
}

/** One row of `listWorkspacesForOrganization`. */
export type PlatformWorkspaceRow = Awaited<
  ReturnType<typeof platformEstateRepository.listWorkspacesForOrganization>
>[number];
