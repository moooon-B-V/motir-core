import type { Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The platform FLEET ORG CI setting (Story MOTIR-8699 · MOTIR-8714) — one row per
 * (project, connected org), `org` stored lower-cased. No row = OFF.
 *
 * The writes and the read that guards them take `tx`: they run inside
 * `withPlatformWrite` (the `app.platform_staff` arm the table's write policy
 * reads). The state read takes an optional `tx`; its SELECT policy is
 * unconditional, so the console reads it outside any platform transaction.
 */

/** One setting row, as stored. */
export interface PlatformFleetOrgCiRow {
  projectId: string;
  org: string;
  enabled: boolean;
  lastReason: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

const ROW = {
  projectId: true,
  org: true,
  enabled: true,
  lastReason: true,
  updatedByUserId: true,
  updatedAt: true,
} as const;

export const platformFleetOrgCiRepository = {
  /** The row for one pair, or null (OFF). */
  async find(
    projectId: string,
    org: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlatformFleetOrgCiRow | null> {
    const client = tx ?? dbRead;
    return client.platformFleetOrgCi.findUnique({
      where: { projectId_org: { projectId, org } },
      select: ROW,
    });
  },

  /**
   * Lock the pair's row for the rest of the transaction and answer its `enabled`,
   * or null when there is no row yet. Two flips of one pair serialise here, so
   * the second re-reads what the first committed.
   */
  async lockForUpdate(
    projectId: string,
    org: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ enabled: boolean } | null> {
    const rows = await tx.$queryRaw<{ enabled: boolean }[]>`
      SELECT "enabled" FROM "platform_fleet_org_ci"
      WHERE "project_id" = ${projectId} AND "org" = ${org}
      FOR UPDATE`;
    return rows[0] ?? null;
  },

  /** Write the pair's state, creating its row on the first flip. */
  async upsert(
    input: {
      projectId: string;
      org: string;
      enabled: boolean;
      lastReason: string;
      updatedByUserId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlatformFleetOrgCiRow> {
    const { projectId, org, ...state } = input;
    return tx.platformFleetOrgCi.upsert({
      where: { projectId_org: { projectId, org } },
      create: { projectId, org, ...state },
      update: state,
      select: ROW,
    });
  },
};
