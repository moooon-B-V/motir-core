import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { toPlanTreeSkeleton, toOrgContextResponse } from '@/lib/mappers/aiBoundaryMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanTreeResponse, OrgContextResponse } from '@/lib/dto/ai';

// The ai→core boundary service (Subtask 7.1.6). The READ-back side of the
// boundary: the project's work-item skeleton (plan-tree) + the calling org's
// footprint (org-context), each orchestrated through the SAME permission-scoped
// services the UI/MCP use — never raw Prisma — so the AI reads only what the
// token's user could. Deliberately minimal: the rich graph-traversal retrieval is
// Story 7.5; this is the skeleton it grows from.
//
// The former WRITE side — `commitPlanDelta` / `POST /api/internal/ai/plan-delta`,
// the whole-delta buffered persist — was REMOVED by 7.4.4 (MOTIR-846). Generation
// no longer buffers a delta: it EMITS incremental `add` PlanItem proposals into a
// 7.21 `Plan` via `POST /api/internal/ai/plan-proposals` (aiGenerationService),
// and a real work-item tree appears only on APPROVE/materialize. There is no
// buffered atomic-persist path.

export const aiBoundaryService = {
  // GET /api/internal/ai/plan-tree — the project's work-item skeleton. The
  // listWorkItems gate raises ProjectNotFoundError (404, never 403) for a
  // project the token's user can't browse — the cross-tenant posture (finding
  // #26). `projectKey` comes from the gated project row.
  async readPlanTree(projectId: string, ctx: ServiceContext): Promise<PlanTreeResponse> {
    const items = await workItemsService.listWorkItems(projectId, {}, ctx);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    return {
      project: { projectId, projectKey: project.identifier },
      items: toPlanTreeSkeleton(items),
    };
  },

  // GET /api/internal/ai/org-context (Subtask 7.3.45) — the calling org's
  // existing footprint, the read-back the discovery interview weighs when it
  // classifies a new project. The token scopes to a WORKSPACE; the org is that
  // workspace's parent. resolveWorkspaceAccess gates the workspace AS the token's
  // user AND yields its organizationId in one call (returns null when the user
  // can't reach the workspace → 404-not-403, the no-leak posture); the org
  // footprint is then summarised through organizationsService (also AS the user).
  async readOrgContext(ctx: ServiceContext): Promise<OrgContextResponse> {
    const access = await organizationsService.resolveWorkspaceAccess(ctx.userId, ctx.workspaceId);
    if (!access) {
      // The token's user can't reach this workspace — surface as not-found, never
      // leak that the org exists (OrganizationNotFoundError → 404, like plan-tree).
      throw new OrganizationNotFoundError(ctx.workspaceId);
    }
    const footprint = await organizationsService.summarizeOrgFootprint({
      userId: ctx.userId,
      organizationId: access.organizationId,
    });
    return toOrgContextResponse(footprint);
  },
};
