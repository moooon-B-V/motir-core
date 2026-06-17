import { organizationsService } from '@/lib/services/organizationsService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getOrgUsage } from '@/lib/ai/motirAiClient';
import type { RawUsageResponse, UsageScope } from '@/lib/ai/types';
import type { OrgUsageDTO, UsageRunDTO, UsageScopeOption } from '@/lib/dto/aiUsage';

// The org cost dashboard read-through service (Subtask 7.2.11). This is the
// email.ts-style LEAF-CLIENT pattern: motir-core never holds a ledger — the
// metering + balance live in motir-ai and are fetched over the 7.1 boundary. The
// service (1) REUSES the 6.10.4 org gate (never invents one), (2) decides the
// effective drill scope SERVER-SIDE — a non-admin member is narrowed to their
// own project, never trusting a client-sent scope — and (3) enriches the
// motir-ai figures (which only carry ids) with motir-core's own workspace /
// project NAMES before the DTO reaches the browser. No billing table is added to
// motir-core (the open-core invariant).

interface UsageInput {
  organizationId: string;
  actorUserId: string;
  scope?: UsageScope;
  workspaceId?: string | null;
  projectId?: string | null;
  page?: number;
  pageSize?: number;
}

interface ResolvedProject {
  id: string;
  name: string;
  workspaceId: string;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

// Read the projects of one or more workspaces, each under its own workspace
// context so the project RLS policy (keyed on the app.workspace_id GUC) admits
// the rows — an org admin can name every workspace's projects this way even
// without a workspace membership (the policy keys on the workspace, not
// membership). Bounded by the distinct workspaces actually referenced.
async function projectsOfWorkspaces(
  actorUserId: string,
  workspaceIds: string[],
): Promise<ResolvedProject[]> {
  const out: ResolvedProject[] = [];
  for (const workspaceId of unique(workspaceIds)) {
    const projects = await withWorkspaceContext({ userId: actorUserId, workspaceId }, (tx) =>
      projectRepository.findByWorkspace(workspaceId, tx),
    );
    for (const p of projects) out.push({ id: p.id, name: p.name, workspaceId });
  }
  return out;
}

// An all-zero DTO for a scope with nothing to fetch (e.g. a member with no
// accessible project) — rendered as the empty / limited state, never a call.
function emptyDto(args: {
  isAdmin: boolean;
  org: { id: string; name: string };
  scope: UsageScope;
  drill: { workspaces: UsageScopeOption[]; projects: UsageScopeOption[] };
  page: number;
  pageSize: number;
}): OrgUsageDTO {
  return {
    access: { isAdmin: args.isAdmin },
    scope: args.scope,
    org: args.org,
    activeWorkspace: null,
    activeProject: null,
    drill: args.drill,
    balance: 0,
    tier: null,
    totalSpend: 0,
    monthSpend: 0,
    monthlyHistory: [],
    perModel: [],
    recentRuns: { runs: [], page: args.page, pageSize: args.pageSize, total: 0 },
    hasUsage: false,
  };
}

export const aiUsageService = {
  /**
   * The org cost dashboard rollup at a drill level. Throws
   * OrganizationNotFoundError (→ 404) for a non-member of the org (the gate),
   * and lets a motir-ai transport/upstream failure propagate as a MotirAiError
   * (→ the route's 502 → the dashboard's error/retry state).
   */
  async getUsage(input: UsageInput): Promise<OrgUsageDTO> {
    // (1) Gate — reuse the 6.10.4 org access check (404 for a non-member).
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );

    // (2) Resolve the org's structure (names) + the member's accessible
    // workspaces, under the org context so the membership RLS admits the reads.
    const struct = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        const org = await organizationRepository.findByIdInTx(input.organizationId, tx);
        const workspaces = await workspaceRepository.listByOrganization(input.organizationId, tx);
        let accessibleWorkspaceIds: string[] | null = null; // null = admin (all)
        if (!access.isOrgAdmin) {
          const memberships = await workspaceMembershipRepository.findByWorkspaceIdsAndUserIds(
            workspaces.map((w) => w.id),
            [input.actorUserId],
            tx,
          );
          accessibleWorkspaceIds = unique(memberships.map((m) => m.workspaceId));
        }
        return {
          orgName: org?.name ?? '',
          orgWorkspaces: workspaces.map((w) => ({ id: w.id, name: w.name }) as UsageScopeOption),
          accessibleWorkspaceIds,
        };
      },
    );

    const org = { id: input.organizationId, name: struct.orgName };
    const wsNameById = new Map(struct.orgWorkspaces.map((w) => [w.id, w.name]));
    const projectNameById = new Map<string, ResolvedProject>();

    // (3) Decide the EFFECTIVE scope server-side. An admin gets the requested
    // drill (validated against the org); a member is locked to their own project.
    // Track which workspaces we've already read projects for (so the run-log
    // name enrichment never re-reads one).
    const resolvedWorkspaceIds = new Set<string>();
    const resolveProjects = async (workspaceIds: string[]): Promise<ResolvedProject[]> => {
      const toRead = unique(workspaceIds).filter((id) => id && !resolvedWorkspaceIds.has(id));
      const projs = await projectsOfWorkspaces(input.actorUserId, toRead);
      for (const id of toRead) resolvedWorkspaceIds.add(id);
      for (const p of projs) projectNameById.set(p.id, p);
      return projs;
    };

    let scope: UsageScope;
    let coreWorkspaceId: string | null = null;
    let coreProjectId: string | null = null;
    let drillProjects: UsageScopeOption[] = [];
    const drillWorkspaces: UsageScopeOption[] = access.isOrgAdmin ? struct.orgWorkspaces : [];

    if (access.isOrgAdmin) {
      scope = input.scope ?? 'org';
      if (scope === 'workspace' || scope === 'project') {
        // The requested workspace must belong to the org, else fall back to org.
        if (input.workspaceId && wsNameById.has(input.workspaceId)) {
          coreWorkspaceId = input.workspaceId;
        } else {
          scope = 'org';
        }
      }
      if (coreWorkspaceId) {
        const projs = await resolveProjects([coreWorkspaceId]);
        drillProjects = projs.map((p) => ({ id: p.id, name: p.name }));
      }
      if (scope === 'project') {
        // The requested project must live in the active workspace, else narrow up.
        if (input.projectId && projectNameById.has(input.projectId)) {
          coreProjectId = input.projectId;
        } else {
          scope = 'workspace';
        }
      }
    } else {
      // Member — own project slice only. The drill offers ONLY their projects.
      scope = 'project';
      const accessibleProjects = await resolveProjects(struct.accessibleWorkspaceIds ?? []);
      drillProjects = accessibleProjects.map((p) => ({ id: p.id, name: p.name }));
      const chosen =
        (input.projectId ? projectNameById.get(input.projectId) : undefined) ??
        accessibleProjects[0] ??
        null;
      coreProjectId = chosen?.id ?? null;
      coreWorkspaceId = chosen?.workspaceId ?? null;
    }

    const page = input.page;
    const pageSize = input.pageSize;

    // A project scope with no resolved project (a member with no accessible
    // project) has nothing to fetch — render the empty / limited state.
    if (scope === 'project' && !coreProjectId) {
      return emptyDto({
        isAdmin: access.isOrgAdmin,
        org,
        scope,
        drill: { workspaces: drillWorkspaces, projects: drillProjects },
        page: page ?? 1,
        pageSize: pageSize ?? 10,
      });
    }

    // (4) Fetch the figures over the 7.1 boundary (a failure throws a
    // MotirAiError the route maps to the dashboard's error state).
    const raw: RawUsageResponse = await getOrgUsage({
      coreOrganizationId: input.organizationId,
      scope,
      coreWorkspaceId,
      coreProjectId,
      page,
      pageSize,
    });

    // (5) Enrich the run log with project names. Org-scope runs span workspaces,
    // so resolve any workspace on this page we haven't read yet (bounded by the
    // distinct workspaces in a single page).
    await resolveProjects(raw.recentRuns.runs.map((r) => r.coreWorkspaceId));

    const runs: UsageRunDTO[] = raw.recentRuns.runs.map((r) => ({
      jobId: r.jobId,
      jobKind: r.jobKind,
      model: r.model,
      projectId: r.coreProjectId,
      projectName: projectNameById.get(r.coreProjectId)?.name ?? '',
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      credits: r.credits,
      startedAt: r.startedAt,
    }));

    const activeWorkspace: UsageScopeOption | null = coreWorkspaceId
      ? { id: coreWorkspaceId, name: wsNameById.get(coreWorkspaceId) ?? '' }
      : null;
    const activeProject: UsageScopeOption | null = coreProjectId
      ? { id: coreProjectId, name: projectNameById.get(coreProjectId)?.name ?? '' }
      : null;

    return {
      access: { isAdmin: access.isOrgAdmin },
      scope,
      org,
      activeWorkspace,
      activeProject,
      drill: { workspaces: drillWorkspaces, projects: drillProjects },
      balance: raw.balance,
      tier: raw.tier,
      totalSpend: raw.totalSpend,
      monthSpend: raw.monthSpend,
      monthlyHistory: raw.monthlyHistory,
      perModel: raw.perModel,
      recentRuns: {
        runs,
        page: raw.recentRuns.page,
        pageSize: raw.recentRuns.pageSize,
        total: raw.recentRuns.total,
      },
      hasUsage: raw.totalSpend > 0 || raw.recentRuns.total > 0,
    };
  },
};
