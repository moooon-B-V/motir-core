import type { OrgFeatureFlag, Prisma, User } from '@/generated/prisma/client';

/** An override row with the operator who last flipped it — the console's row. */
export type OrgFeatureFlagWithActor = OrgFeatureFlag & {
  updatedBy: Pick<User, 'id' | 'name' | 'email'> | null;
};

/**
 * Everything the hot-path evaluation needs about one organization, in ONE
 * statement: the org's id, its suspension, and its override rows. `flags` is
 * empty for an org with no overrides (every switch at its default).
 */
export interface OrgFeatureState {
  organizationId: string;
  suspendedAt: Date | null;
  flags: { key: string; enabled: boolean }[];
}

interface StateRow {
  organization_id: string;
  suspended_at: Date | null;
  key: string | null;
  enabled: boolean | null;
}

function foldState(rows: StateRow[]): OrgFeatureState | null {
  const first = rows[0];
  if (!first) return null;
  return {
    organizationId: first.organization_id,
    suspendedAt: first.suspended_at,
    flags: rows.flatMap((r) =>
      r.key !== null && r.enabled !== null ? [{ key: r.key, enabled: r.enabled }] : [],
    ),
  };
}

/**
 * `org_feature_flag` — per-organization kill-switch OVERRIDES (Story 10.3 ·
 * MOTIR-750). Single operations only; the evaluation rule ("override, else the
 * registry default") and the audit live in the service.
 *
 * RLS: readable under `app.platform_staff` or `app.system_admin`, writable only
 * under `app.platform_staff`. No tenant arm.
 */
export const orgFeatureFlagRepository = {
  /**
   * The org's state by ORGANIZATION id — one LEFT JOIN, so the evaluation costs
   * one round trip whether or not the org has overrides. `null` for an unknown
   * org. Run under the system context (or the platform one).
   */
  async readStateByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgFeatureState | null> {
    const rows = await tx.$queryRaw<StateRow[]>`
      SELECT o."id" AS organization_id, o."suspended_at", f."key", f."enabled"
      FROM "organization" o
      LEFT JOIN "org_feature_flag" f ON f."organization_id" = o."id"
      WHERE o."id" = ${organizationId}
    `;
    return foldState(rows);
  },

  /** {@link readStateByOrganizationId}, resolved from a WORKSPACE id. */
  async readStateByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgFeatureState | null> {
    const rows = await tx.$queryRaw<StateRow[]>`
      SELECT o."id" AS organization_id, o."suspended_at", f."key", f."enabled"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      LEFT JOIN "org_feature_flag" f ON f."organization_id" = o."id"
      WHERE w."id" = ${workspaceId}
    `;
    return foldState(rows);
  },

  /** Every override of one org, with who last flipped each — the console read. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgFeatureFlagWithActor[]> {
    return tx.orgFeatureFlag.findMany({
      where: { organizationId },
      include: { updatedBy: { select: { id: true, name: true, email: true } } },
      orderBy: { key: 'asc' },
    });
  },

  /** One override, inside the flip's transaction (after the org row is locked). */
  async findByOrgAndKey(
    organizationId: string,
    key: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgFeatureFlag | null> {
    return tx.orgFeatureFlag.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
  },

  /** Write the override — insert on the first flip, update after. */
  async upsert(
    data: {
      organizationId: string;
      key: string;
      enabled: boolean;
      reason: string;
      updatedByUserId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<OrgFeatureFlagWithActor> {
    const { organizationId, key, enabled, reason, updatedByUserId } = data;
    return tx.orgFeatureFlag.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, enabled, reason, updatedByUserId },
      update: { enabled, reason, updatedByUserId },
      include: { updatedBy: { select: { id: true, name: true, email: true } } },
    });
  },
};
