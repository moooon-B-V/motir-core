import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { parsePlanDelta, PlanDeltaValidationError, type PlanDelta } from '@/lib/ai/planDelta';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { WorkItemPriorityDto, WorkItemTypeDto } from '@/lib/dto/workItems';

export class PlanDeltaApproveError extends Error {
  readonly code = 'PLAN_DELTA_APPROVE_ERROR' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'PlanDeltaApproveError';
  }
}

export class PlanDeltaImmutabilityError extends Error {
  readonly code = 'PLAN_DELTA_IMMUTABLE' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'PlanDeltaImmutabilityError';
  }
}

export class InvalidTargetError extends Error {
  readonly code = 'INVALID_TARGET' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidTargetError';
  }
}

export interface ApproveDeltaResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

function buildTenant(ctx: ProjectContext, organizationId: string, isMeta: boolean) {
  return {
    organizationId,
    isMeta,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
  };
}

export const aiPlanEditsService = {
  async submitAugment(prompt: string, ctx: ProjectContext): Promise<{ jobId: string }> {
    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const code = await resolveCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = buildTenant(ctx, organizationId, isMeta);
    return submitJob(
      'augment',
      tenant,
      {
        prompt,
        ...(code ? { code } : {}),
      },
      { userId: ctx.userId },
    );
  },

  async submitExpand(itemKey: string, ctx: ProjectContext): Promise<{ jobId: string }> {
    const wi = await workItemRepository.findByIdentifier(ctx.projectId, itemKey);
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const containerKinds = new Set(['epic', 'story', 'task', 'bug']);
    if (!containerKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — expand requires a container (epic/story/task/bug)`,
      );
    }

    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const code = await resolveCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = buildTenant(ctx, organizationId, isMeta);
    return submitJob(
      'expand_item',
      tenant,
      {
        rootItemKey: itemKey,
        ...(code ? { code } : {}),
      },
      { userId: ctx.userId },
    );
  },

  async submitReplan(itemKey: string, ctx: ProjectContext): Promise<{ jobId: string }> {
    const wi = await workItemRepository.findByIdentifier(ctx.projectId, itemKey);
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const replanKinds = new Set(['epic', 'story']);
    if (!replanKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — replan requires an epic or story`,
      );
    }

    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const code = await resolveCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = buildTenant(ctx, organizationId, isMeta);
    return submitJob(
      'replan',
      tenant,
      {
        rootItemKey: itemKey,
        ...(code ? { code } : {}),
      },
      { userId: ctx.userId },
    );
  },

  streamAugment(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  streamExpand(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  streamReplan(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  async approveDelta(
    jobId: string,
    editedDelta: unknown | undefined,
    ctx: ProjectContext,
  ): Promise<ApproveDeltaResult> {
    let rawDelta: unknown;
    if (editedDelta !== undefined && editedDelta !== null) {
      rawDelta = editedDelta;
    } else {
      const job = await getJob(jobId);
      if (!job.result?.planDelta) {
        throw new PlanDeltaApproveError(
          `Job ${jobId} has no delta result — job status is ${job.status}`,
        );
      }
      rawDelta = job.result.planDelta;
    }

    let delta: PlanDelta;
    try {
      delta = parsePlanDelta(rawDelta);
    } catch (err) {
      if (err instanceof PlanDeltaValidationError) {
        throw err;
      }
      throw new PlanDeltaApproveError(err instanceof Error ? err.message : 'Failed to parse delta');
    }

    const terminalKeys = await workflowsService.getTerminalStatusKeys(
      ctx.projectId,
      ctx.workspaceId,
    );

    const svcCtx: ServiceContext = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    const created: string[] = [];
    const updated: string[] = [];
    const refToKey = new Map<string, string>();

    for (const op of delta.operations) {
      if (op.op === 'create') {
        const parentId =
          op.parentKey ?? (op.parentRef ? (refToKey.get(op.parentRef) ?? null) : null);
        const wi = await workItemsService.createWorkItem(
          {
            projectId: ctx.projectId,
            kind: op.kind,
            title: op.fields.title,
            descriptionMd: op.fields.descriptionMd ?? null,
            type: op.fields.type ?? null,
            executor: null,
            estimateMinutes: op.fields.estimateMinutes ?? null,
            priority: op.fields.priority,
            parentId,
          },
          svcCtx,
        );
        created.push(wi.identifier);
        if (op.ref) refToKey.set(op.ref, wi.identifier);
      } else if (op.op === 'update') {
        const targetKey = op.targetKey;
        const existing = await workItemRepository.findByIdentifier(ctx.projectId, targetKey);
        if (!existing) {
          throw new PlanDeltaApproveError(`Target item ${targetKey} not found`);
        }
        if (terminalKeys.has(existing.status)) {
          throw new PlanDeltaImmutabilityError(
            `Work item ${targetKey} is in a terminal status and cannot be modified`,
          );
        }

        const patch: {
          title?: string;
          descriptionMd?: string | null;
          type?: WorkItemTypeDto | null;
          priority?: WorkItemPriorityDto;
          estimateMinutes?: number | null;
        } = {};
        if (op.fields.title !== undefined) patch.title = op.fields.title;
        if (op.fields.descriptionMd !== undefined) patch.descriptionMd = op.fields.descriptionMd;
        if (op.fields.type !== undefined) patch.type = op.fields.type as WorkItemTypeDto | null;
        if (op.fields.priority !== undefined)
          patch.priority = op.fields.priority as WorkItemPriorityDto;
        if (op.fields.estimateMinutes !== undefined) {
          patch.estimateMinutes = op.fields.estimateMinutes;
        }

        if (Object.keys(patch).length > 0) {
          await workItemsService.updateWorkItem(existing.id, patch, svcCtx);
          updated.push(targetKey);
        } else {
          // No fields to update — the op was a no-op, still counts as
          // "processed" (acceptance: an all-rejected delta is valid no-op).
          updated.push(targetKey);
        }
      }
    }

    return { created, updated, unchanged: [] };
  },
};
