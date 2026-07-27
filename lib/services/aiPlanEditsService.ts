import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { parsePlanDelta, PlanDeltaValidationError, type PlanDelta } from '@/lib/ai/planDelta';
import type { JobContextBag, JobKind, JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { plansService } from '@/lib/services/plansService';
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

/** The job kinds a plan EDIT submits — the 7.11/7.12 set (`generate_tree` is
 *  `aiGenerationService`'s). All three write their output through the 7.21
 *  Plan/PlanItem proposal store. */
type PlanEditJobKind = Extract<JobKind, 'augment' | 'expand_item' | 'replan'>;

/**
 * The ids a plan-edit submit hands back.
 *
 * The shape GREW a `planId` alongside `jobId` (MOTIR-1743) — the decision the
 * bug asked to record: it mirrors `aiGenerationService.startGeneration`'s
 * `{ jobId, planId }` exactly, so both producers into the 7.21 Plan substrate
 * return the same pair, and a caller that wants to link the user straight to
 * `/plans/<id>` no longer has to re-resolve the plan by `sourceJobId`. It is
 * ADDITIVE: the REST routes echo it, and every existing consumer
 * (`planEditsClient`, `usePlanEditsJob`, `planChangeSessionsService`)
 * destructures `{ jobId }` and reads the new field defensively (optional in the
 * browser-facing client types, since a stubbed/older response carries only
 * `jobId`).
 */
export interface PlanEditSubmitResult {
  jobId: string;
  planId: string;
}

/**
 * Submit a plan-edit job AND open the `generating` `Plan` its proposals append
 * into — the ONE shared step every plan-edit submit needs (MOTIR-1743).
 *
 * Before this, the four submits stopped at `submitJob`, so no `Plan` existed for
 * the job. But motir-ai's `augment` / `expand_item` / `replan` handlers write
 * their output through the Plan/PlanItem proposal store (`addProposals` →
 * `markPlanned`), and the core seam those callbacks land on
 * (`aiGenerationService.appendProposals`) resolves the plan by `sourceJobId` —
 * so EVERY plan-edit job died on its first callback with
 * `NoPlanForJobError` → 404. Opening the plan here is the missing half.
 *
 * Order is deliberate and copied from `startGeneration`: the job is submitted
 * FIRST so the Plan can bind to it via `sourceJobId`, and so a failed submit
 * (motir-ai unreachable / out-of-credits) leaves NO orphan Plan behind — the
 * typed `MotirAiError` propagates before any row is written.
 *
 * The Plan is opened untitled (`title`/`summary` null), exactly as
 * `startGeneration` does by default; the review surfaces already render the
 * `untitledPlan` fallback.
 */
async function submitPlanEditJob(
  kind: PlanEditJobKind,
  context: JobContextBag,
  ctx: ProjectContext,
): Promise<PlanEditSubmitResult> {
  const { organizationId, isMeta } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const code = await resolveCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const tenant = buildTenant(ctx, organizationId, isMeta);
  const { jobId } = await submitJob(
    kind,
    tenant,
    {
      ...context,
      ...(code ? { code } : {}),
    },
    { userId: ctx.userId },
  );
  const plan = await plansService.createPlan(
    ctx.projectId,
    { title: null, summary: null, sourceJobId: jobId },
    ctx,
  );
  return { jobId, planId: plan.id };
}

export const aiPlanEditsService = {
  async submitAugment(prompt: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
    return submitPlanEditJob('augment', { prompt }, ctx);
  },

  /**
   * Submit a CONTEXTUAL planning turn — a chat turn anchored at one or more work
   * items (7.12.3 · MOTIR-909), riding the SHIPPED 7.11 job contract.
   *
   * Two things make this different from {@link submitAugment}, and only two:
   *
   *  1. `context.targetKeys` carries the anchor SET. That flag is what turns the
   *     submit into a contextual turn on the motir-ai side (7.12.2 · MOTIR-908):
   *     the scoping module CLASSIFIES the intent from the turn text, RESOLVES which
   *     of `expand_item` / `augment` / `replan` it really is (structure overrides
   *     text — a leaf cannot be expanded; a subtask re-plan climbs to its story),
   *     and pushes the UNION of every anchor's item + parent + siblings + children
   *     as grounding.
   *  2. The submitted kind is therefore only the FALLBACK when the turn text
   *     carries no signal, and `augment` — additions-only — is deliberately that
   *     floor: the safest thing to do with an ambiguous instruction is propose
   *     ADDITIONS, never a re-shape. Core does NOT pre-classify; that would put two
   *     classifiers in the loop and let core's guess override the engine's.
   *
   * The re-plan "reason" is the turn text itself — there is no separate `reason`
   * param, by contract. NO new job kind is introduced. Nothing is written to the
   * TREE here: this SUBMITS and opens the job's empty `generating` Plan (the
   * proposal sink — MOTIR-1743); no work item is touched, and persisting a
   * returned delta stays behind the confirmation gate (7.13.5) on the approve
   * route.
   */
  async submitContextual(
    prompt: string,
    targetKeys: readonly string[],
    ctx: ProjectContext,
  ): Promise<PlanEditSubmitResult> {
    return submitPlanEditJob('augment', { prompt, targetKeys: [...targetKeys] }, ctx);
  },

  /** The live channel for a contextual planning turn's job — the same 7.1.4 job
   *  stream every plan-edit surface relays, named for its caller so the panel's
   *  route reads as one seam. Browsers stream from CORE, never from motir-ai. */
  streamContextual(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  async submitExpand(itemKey: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
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

    return submitPlanEditJob('expand_item', { rootItemKey: itemKey }, ctx);
  },

  async submitReplan(itemKey: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
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

    return submitPlanEditJob('replan', { rootItemKey: itemKey }, ctx);
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
    // ref → the CREATED item's DATABASE id (not its identifier): `parentId` on
    // CreateWorkItemInput is a DB id, so an in-delta `parentRef` must resolve to
    // one directly.
    const refToId = new Map<string, string>();

    for (const op of delta.operations) {
      if (op.op === 'create') {
        // `parentKey` is an existing item's KEY ("ARP-1", the planDelta
        // contract), but `createWorkItem` takes a DB id and looks it up with
        // findById — passing the key straight through made every parented
        // create throw WorkItemNotFoundError (a 500 on approve), so resolve the
        // key to its id first.
        let parentId: string | null = null;
        if (op.parentKey) {
          const parent = await workItemRepository.findByIdentifier(ctx.projectId, op.parentKey);
          if (!parent) {
            throw new PlanDeltaApproveError(`Parent item ${op.parentKey} not found`);
          }
          parentId = parent.id;
        } else if (op.parentRef) {
          parentId = refToId.get(op.parentRef) ?? null;
        }
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
        if (op.ref) refToId.set(op.ref, wi.id);
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
