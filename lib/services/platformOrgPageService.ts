import 'server-only';

import {
  getOrgUsage,
  getPlatformRuns,
  getPlatformUsage,
  getPlatformUsageChildren,
  getPlatformUsageMonths,
  type RawPlatformRunsPage,
  type RawPlatformUsage,
  type RawPlatformUsageChildren,
  type RawSpendRow,
} from '@/lib/ai/motirAiClient';
import type {
  PlatformOrgOverviewDTO,
  PlatformOrgUsageScope,
  PlatformOrgUsageTabDTO,
  PlatformWorkspacePageDTO,
} from '@/lib/dto/platform';
import {
  toPlatformAuditLogDTO,
  toPlatformOrganizationDetailDTO,
  toPlatformRunActivityDTO,
  toPlatformWorkspaceSummaryDTO,
} from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import {
  PlatformOrganizationNotFoundError,
  PlatformWorkspaceNotFoundError,
} from '@/lib/platform/errors';
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
/** The scope picker's cap on projects — an org beyond it picks through its workspaces. */
export const ORG_SCOPE_PROJECT_LIMIT = 500;
/** One read of an entity's children for the by-workspace table. */
export const ORG_CHILDREN_LIMIT = 100;
/** Months per page of the month-by-month table. */
export const ORG_MONTHS_PAGE = 24;
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

  /**
   * The Usage & cost tab (MOTIR-7288, design D8/D11): one scope (the org, one of
   * its workspaces or projects) for one period.
   *
   * ⚠️ THE SCOPE IS CHECKED BEFORE motir-ai IS ASKED. The ids arrive in the URL; a
   * workspace or project of ANOTHER org must never be read under this org's page.
   * So the ONE audited read (naming the org and the scope) runs first — the org,
   * the picker's workspaces and projects, and the scope resolved against them —
   * and only a scope that belongs to the org reaches motir-ai. An id that does not
   * is the org scope. motir-ai unreachable is `usage: null`, never a throw.
   */
  async getUsageTab(
    principal: PlatformPrincipal,
    organizationId: string,
    input: { period: string; scope?: string | null; monthsCursor?: string | null },
  ): Promise<PlatformOrgUsageTabDTO> {
    await requirePlatformStaff('support');
    const asked = parseScopeParam(input.scope);

    const local = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
        targetLabel: `usage ${asked ? `${asked.level}:${asked.id}` : 'organization'} ${input.period}`,
      },
      async (tx) => {
        const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
        const workspaces = await platformEstateRepository.listWorkspacesForOrganization(
          organizationId,
          PLATFORM_ORG_WORKSPACE_LIMIT,
          tx,
        );
        const projects = await platformEstateRepository.listProjectsForOrganization(
          organizationId,
          ORG_SCOPE_PROJECT_LIMIT,
          tx,
        );
        return { org, workspaces, projects };
      },
    );

    const wsById = new Map(local.workspaces.map((w) => [w.id, w]));
    let scope: PlatformOrgUsageScope = { level: 'organization' };
    if (asked?.level === 'workspace' && wsById.has(asked.id)) {
      scope = { level: 'workspace', id: asked.id, name: wsById.get(asked.id)!.name };
    } else if (asked?.level === 'project') {
      const p = local.projects.find((x) => x.id === asked.id);
      const ws = p ? wsById.get(p.workspaceId) : undefined;
      if (p && ws)
        scope = {
          level: 'project',
          id: p.id,
          name: p.name,
          workspace: { id: ws.id, name: ws.name },
        };
    }

    const entityId = scope.level === 'organization' ? organizationId : scope.id;
    const [usage, balance, children, months] = await Promise.all([
      settle(getPlatformUsage({ period: input.period, level: scope.level, entityId })),
      settle(
        getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' }).then((u) => u.balance),
      ),
      scope.level === 'project'
        ? Promise.resolve(null)
        : settle(
            getPlatformUsageChildren({
              period: input.period,
              level: scope.level,
              entityId,
              sort: 'cost',
              limit: ORG_CHILDREN_LIMIT,
            }),
          ),
      settle(
        getPlatformUsageMonths({
          level: scope.level,
          entityId,
          limit: ORG_MONTHS_PAGE,
          cursor: input.monthsCursor ?? null,
        }),
      ),
    ]);
    const names = new Map<string, string>([
      ...local.workspaces.map((w) => [w.id, w.name] as const),
      ...local.projects.map((p) => [p.id, p.name] as const),
    ]);

    return {
      organization: toPlatformOrganizationDetailDTO(local.org),
      period: input.period,
      scope,
      scopes: local.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        projects: local.projects
          .filter((p) => p.workspaceId === w.id)
          .map((p) => ({ id: p.id, name: p.name })),
      })),
      usage,
      balance,
      children: children
        ? {
            childLevel:
              scope.level === 'organization' ? ('workspace' as const) : ('project' as const),
            rows: children.items.map((r) => ({ ...r, name: names.get(r.entityId) ?? r.entityId })),
            remainder: children.remainder,
            truncated: children.nextCursor !== null,
          }
        : null,
      childrenUnavailable: scope.level !== 'project' && children === null,
      months,
    };
  },

  /**
   * One workspace's PROJECTS for the by-workspace table's expansion (MOTIR-7293).
   * The workspace must belong to the org in the URL — checked in the ONE audited
   * read before motir-ai is asked; anything else is a not-found.
   */
  async getWorkspaceProjectsSpend(
    principal: PlatformPrincipal,
    organizationId: string,
    workspaceId: string,
    period: string,
  ): Promise<{ rows: (RawSpendRow & { name: string })[]; truncated: boolean } | null> {
    await requirePlatformStaff('support');
    const projects = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
        targetLabel: `usage workspace:${workspaceId} projects ${period}`,
      },
      async (tx) => {
        const workspaces = await platformEstateRepository.listWorkspacesForOrganization(
          organizationId,
          PLATFORM_ORG_WORKSPACE_LIMIT,
          tx,
        );
        if (!workspaces.some((w) => w.id === workspaceId)) {
          throw new PlatformOrganizationNotFoundError(organizationId);
        }
        const all = await platformEstateRepository.listProjectsForOrganization(
          organizationId,
          ORG_SCOPE_PROJECT_LIMIT,
          tx,
        );
        return all.filter((p) => p.workspaceId === workspaceId);
      },
    );
    const page = await settle(
      getPlatformUsageChildren({
        period,
        level: 'workspace',
        entityId: workspaceId,
        sort: 'cost',
        limit: ORG_CHILDREN_LIMIT,
      }),
    );
    if (!page) return null;
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return {
      rows: page.items.map((r) => ({ ...r, name: names.get(r.entityId) ?? r.entityId })),
      truncated: page.nextCursor !== null,
    };
  },

  /**
   * The WORKSPACE PAGE beneath the org (MOTIR-7295, design D6): its projects with
   * this month's spend, its members (keyset) and its attributed recent jobs.
   *
   * The pair in the URL is checked FIRST: ONE audited `estate.read` naming the
   * workspace reads it only if it belongs to the org — anything else throws inside
   * the read (404, no audit row) and motir-ai is never asked. Then motir-ai's two
   * reads, each failing to its region's unavailable state.
   */
  async getWorkspacePage(
    principal: PlatformPrincipal,
    organizationId: string,
    workspaceId: string,
    input: { membersCursor?: string | null; jobsCursor?: string | null; now?: Date } = {},
  ): Promise<PlatformWorkspacePageDTO> {
    await requirePlatformStaff('support');
    const month = currentMonth(input.now);
    const membersAfter = decodeCursor(input.membersCursor);

    const local = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'workspace', targetId: workspaceId, organizationId },
      async (tx) => {
        const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        const workspace = org
          ? await platformEstateRepository.findWorkspaceInOrganization(
              organizationId,
              workspaceId,
              tx,
            )
          : null;
        if (!org || !workspace) throw new PlatformWorkspaceNotFoundError(workspaceId);
        const projects = await platformEstateRepository.listProjectsForWorkspace(
          workspaceId,
          ORG_SCOPE_PROJECT_LIMIT,
          tx,
        );
        const memberRows = await platformEstateRepository.listWorkspaceMembers(
          workspaceId,
          { take: ORG_MEMBERS_PAGE + 1, after: membersAfter },
          tx,
        );
        const memberTotal = await platformEstateRepository.countWorkspaceMembers(workspaceId, tx);
        return { org, workspace, projects, memberRows, memberTotal };
      },
    );

    const [children, runs] = (await Promise.all([
      settle(
        getPlatformUsageChildren({
          period: month,
          level: 'workspace',
          entityId: workspaceId,
          sort: 'cost',
          limit: ORG_CHILDREN_LIMIT,
        }),
      ),
      settle(
        getPlatformRuns({
          coreWorkspaceId: workspaceId,
          limit: ORG_JOBS_PAGE,
          cursor: input.jobsCursor ?? null,
        }),
      ),
    ])) as [RawPlatformUsageChildren | null, RawPlatformRunsPage | null];

    const spend = new Map((children?.items ?? []).map((r) => [r.entityId, r]));
    const names = new Map<string, string>([
      [local.org.id, local.org.name],
      [local.workspace.id, local.workspace.name],
      ...local.projects.map((p) => [p.id, p.name] as const),
    ]);
    const members = local.memberRows.slice(0, ORG_MEMBERS_PAGE);
    const lastMember = members[members.length - 1];

    return {
      organization: { id: local.org.id, name: local.org.name },
      workspace: { ...local.workspace, createdAt: local.workspace.createdAt.toISOString() },
      month,
      projects: local.projects.map((p) => {
        const r = spend.get(p.id);
        // No row = no spend this month — unless the list was cut off or unread.
        const known = children !== null && (r !== undefined || children.nextCursor === null);
        return {
          id: p.id,
          name: p.name,
          key: p.identifier,
          planningCredits: known ? (r?.credits.planning_tokens ?? 0) : null,
          runsAndCiCredits: known
            ? r
              ? r.credits.agent_tokens + r.credits.agent_machine + r.credits.ci
              : 0
            : null,
          chargedCredits: known ? (r?.chargedCredits ?? 0) : null,
        };
      }),
      projectSpendUnavailable: children === null,
      members: {
        items: members.map((m) => ({
          id: m.id,
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.workspaceRole,
          joinedAt: m.createdAt.toISOString(),
        })),
        nextCursor:
          local.memberRows.length > ORG_MEMBERS_PAGE && lastMember
            ? encodeCursor(lastMember.createdAt, lastMember.id)
            : null,
        total: local.memberTotal,
      },
      jobs: {
        items: (runs?.items ?? []).map((r) => toPlatformRunActivityDTO(r, names)),
        nextCursor: runs?.nextCursor ?? null,
        unavailable: runs === null,
      },
    };
  },
};

/** `?scope=workspace:<id>` / `project:<id>`; anything else is the org. */
export function parseScopeParam(
  raw: string | null | undefined,
): { level: 'workspace' | 'project'; id: string } | null {
  const m = /^(workspace|project):(.+)$/.exec(raw ?? '');
  return m ? { level: m[1] as 'workspace' | 'project', id: m[2]! } : null;
}
