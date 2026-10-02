import 'server-only';

import {
  getPlatformRuns,
  getPlatformUsage,
  getPlatformUsageChildren,
  type RawPlatformRunsPage,
  type RawPlatformUsage,
  type RawPlatformUsageChildren,
} from '@/lib/ai/motirAiClient';
import type { PlatformOrgOverviewDTO } from '@/lib/dto/platform';
import {
  toPlatformAuditLogDTO,
  toPlatformOrganizationDetailDTO,
  toPlatformRunActivityDTO,
  toPlatformWorkspaceSummaryDTO,
} from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { currentMonth } from '@/lib/platform/spend';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import {
  isOperatorWrite,
  PLATFORM_ORG_ACTION_LOG_LIMIT,
} from '@/lib/services/platformBillingClassificationService';
import { PLATFORM_ORG_WORKSPACE_LIMIT } from '@/lib/services/platformReadService';

/**
 * The org page (Story MOTIR-727 · MOTIR-733, design D5) — its Overview tab as ONE
 * audited read.
 *
 * motir-ai's three reads (this month's categories, the workspaces' credits, the
 * org's recent jobs) run FIRST and OUTSIDE the transaction — an HTTP deadline must
 * not hold the audited read's connection — and each failure is a STATE of its
 * region, never a throw. Then ONE `withPlatformRead` (`estate.read`, the org named)
 * reads everything motir-core holds: the org, its action log, a members page, the
 * workspaces and the names behind the jobs' ids. A missing org throws INSIDE it,
 * so a typed-in id leaves no audit row.
 */

export const ORG_MEMBERS_PAGE = 20;
export const ORG_JOBS_PAGE = 10;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: at.toISOString(), i: id })).toString('base64url');
}

/** A malformed cursor reads as the first page — it is a URL a person can edit. */
function decodeCursor(cursor: string | null | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof raw.t !== 'string' || typeof raw.i !== 'string') return null;
    const at = new Date(raw.t);
    return Number.isNaN(at.getTime()) ? null : { at, id: raw.i };
  } catch {
    return null;
  }
}

async function settle<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch {
    return null;
  }
}

export const platformOrgPageService = {
  async getOverview(
    principal: PlatformPrincipal,
    organizationId: string,
    input: { membersCursor?: string | null; jobsCursor?: string | null; now?: Date } = {},
  ): Promise<PlatformOrgOverviewDTO> {
    await requirePlatformStaff('support');
    const month = currentMonth(input.now);

    const [usage, children, runs] = (await Promise.all([
      settle(getPlatformUsage({ period: month, level: 'organization', entityId: organizationId })),
      settle(
        getPlatformUsageChildren({
          period: month,
          level: 'organization',
          entityId: organizationId,
          sort: 'charged',
          limit: 100,
        }),
      ),
      settle(
        getPlatformRuns({
          coreOrganizationId: organizationId,
          limit: ORG_JOBS_PAGE,
          cursor: input.jobsCursor ?? null,
        }),
      ),
    ])) as [RawPlatformUsage | null, RawPlatformUsageChildren | null, RawPlatformRunsPage | null];

    const membersAfter = decodeCursor(input.membersCursor);

    return withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
      },
      async (tx) => {
        const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
        const trail = await platformAuditLogRepository.listByTarget(
          'organization',
          organizationId,
          PLATFORM_ORG_ACTION_LOG_LIMIT,
          tx,
        );
        const memberRows = await platformEstateRepository.listOrganizationMembers(
          organizationId,
          { take: ORG_MEMBERS_PAGE + 1, after: membersAfter },
          tx,
        );
        const memberTotal = await platformEstateRepository.countOrganizationMembers(
          organizationId,
          tx,
        );
        const workspaceRows = await platformEstateRepository.listWorkspacesForOrganization(
          organizationId,
          PLATFORM_ORG_WORKSPACE_LIMIT + 1,
          tx,
        );
        const runItems = runs?.items ?? [];
        const nameRows = runItems.length
          ? await platformEstateRepository.findTenantNames(
              {
                organizationIds: [organizationId],
                workspaceIds: [
                  ...new Set(
                    runItems.flatMap((r) => (r.coreWorkspaceId ? [r.coreWorkspaceId] : [])),
                  ),
                ],
                projectIds: [
                  ...new Set(runItems.flatMap((r) => (r.coreProjectId ? [r.coreProjectId] : []))),
                ],
              },
              tx,
            )
          : [];

        const members = memberRows.slice(0, ORG_MEMBERS_PAGE);
        const lastMember = members[members.length - 1];
        const credits = new Map((children?.items ?? []).map((r) => [r.entityId, r.chargedCredits]));
        const names = new Map(nameRows.map((n) => [n.id, n.name]));

        return {
          organization: toPlatformOrganizationDetailDTO(org),
          actions: trail.filter(isOperatorWrite).map(toPlatformAuditLogDTO),
          monthCategories: usage?.categories ?? null,
          month,
          members: {
            items: members.map((m) => ({
              id: m.id,
              userId: m.user.id,
              name: m.user.name,
              email: m.user.email,
              role: m.role,
              joinedAt: m.createdAt.toISOString(),
            })),
            nextCursor:
              memberRows.length > ORG_MEMBERS_PAGE && lastMember
                ? encodeCursor(lastMember.createdAt, lastMember.id)
                : null,
            total: memberTotal,
          },
          workspaces: workspaceRows.slice(0, PLATFORM_ORG_WORKSPACE_LIMIT).map((w) => ({
            ...toPlatformWorkspaceSummaryDTO(w),
            // A workspace with no rollup row spent nothing this month — unless the
            // children list was cut off, when its absence proves nothing.
            monthChargedCredits: !children
              ? null
              : (credits.get(w.id) ?? (children.nextCursor ? null : 0)),
          })),
          hasMoreWorkspaces: workspaceRows.length > PLATFORM_ORG_WORKSPACE_LIMIT,
          workspaceSpendUnavailable: children === null,
          jobs: {
            items: runItems.map((r) => toPlatformRunActivityDTO(r, names)),
            nextCursor: runs?.nextCursor ?? null,
            unavailable: runs === null,
          },
        };
      },
    );
  },
};
