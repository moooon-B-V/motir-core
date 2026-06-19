import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { toPlanTreeSkeleton, toOrgContextResponse } from '@/lib/mappers/aiBoundaryMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { PlanDeltaValidationError } from '@/lib/ai/planDelta';
import type { PlanDelta, PlanDeltaCreateOp, PlanDeltaFields } from '@/lib/ai/planDelta';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  PlanTreeResponse,
  CommitPlanDeltaResponse,
  PlanDeltaAppliedEntry,
  OrgContextResponse,
} from '@/lib/dto/ai';
import type { CreateWorkItemInput, UpdateWorkItemInput } from '@/lib/dto/workItems';

// The ai→core boundary service (Subtask 7.1.6). Orchestrates the SAME
// permission-scoped workItemsService the UI/MCP use — never raw Prisma — so the
// AI reads/proposes only what the token's user could (the read gate + the create
// gate both run AS that user). Deliberately minimal: the rich graph-traversal
// retrieval is Story 7.5; this is the skeleton it grows from.

// Resolve a create op's parent: an earlier op's ref, an existing item key, or
// none (a top-level create).
async function resolveParentId(
  projectId: string,
  op: PlanDeltaCreateOp,
  refToId: Map<string, string>,
): Promise<string | null> {
  if (op.parentRef !== undefined) {
    const id = refToId.get(op.parentRef);
    if (!id) {
      throw new PlanDeltaValidationError(
        `parentRef "${op.parentRef}" does not name an earlier create in this delta`,
      );
    }
    return id;
  }
  if (op.parentKey !== undefined) {
    const parent = await workItemRepository.findByIdentifier(projectId, op.parentKey);
    if (!parent) {
      throw new PlanDeltaValidationError(`parentKey "${op.parentKey}" not found in this project`);
    }
    return parent.id;
  }
  return null;
}

function toUpdateInput(fields: PlanDeltaFields): UpdateWorkItemInput {
  const patch: UpdateWorkItemInput = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.descriptionMd !== undefined) patch.descriptionMd = fields.descriptionMd;
  if (fields.type !== undefined) patch.type = fields.type;
  if (fields.estimateMinutes !== undefined) patch.estimateMinutes = fields.estimateMinutes;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  return patch;
}

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

  // POST /api/internal/ai/plan-delta — commit the proposed delta through
  // workItemsService (the ONLY write path the AI has). Applies ops in order,
  // resolving refs to ids as it goes. An empty delta is a valid no-op → [].
  async commitPlanDelta(
    projectId: string,
    delta: PlanDelta,
    ctx: ServiceContext,
  ): Promise<CommitPlanDeltaResponse> {
    const refToId = new Map<string, string>();
    const applied: PlanDeltaAppliedEntry[] = [];

    for (const op of delta.operations) {
      if (op.op === 'create') {
        const parentId = await resolveParentId(projectId, op, refToId);
        const input: CreateWorkItemInput = {
          projectId,
          parentId,
          kind: op.kind,
          title: op.fields.title,
          ...(op.fields.descriptionMd !== undefined
            ? { descriptionMd: op.fields.descriptionMd }
            : {}),
          ...(op.fields.type !== undefined ? { type: op.fields.type } : {}),
          ...(op.fields.estimateMinutes !== undefined
            ? { estimateMinutes: op.fields.estimateMinutes }
            : {}),
          ...(op.fields.priority !== undefined ? { priority: op.fields.priority } : {}),
        };
        const created = await workItemsService.createWorkItem(input, ctx);
        if (op.ref !== undefined) refToId.set(op.ref, created.id);
        applied.push({
          op: 'create',
          ...(op.ref !== undefined ? { ref: op.ref } : {}),
          key: created.identifier,
          id: created.id,
        });
      } else {
        const target = await workItemRepository.findByIdentifier(projectId, op.targetKey);
        if (!target) {
          throw new PlanDeltaValidationError(`update targetKey "${op.targetKey}" not found`);
        }
        const updated = await workItemsService.updateWorkItem(
          target.id,
          toUpdateInput(op.fields),
          ctx,
        );
        applied.push({ op: 'update', key: updated.identifier, id: updated.id });
      }
    }

    return { applied };
  },
};
