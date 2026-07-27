import { Prisma, type WorkItem } from '@prisma/client';

import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { parsePlanDelta, PlanDeltaValidationError, type PlanDelta } from '@/lib/ai/planDelta';
import { collectReferencedKeys, gatePlanDelta } from '@/lib/ai/planDeltaGate';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { watchersService } from '@/lib/services/watchersService';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { keyForAppend } from '@/lib/workItems/positioning';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { NoInitialStatusError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
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
   * plan here: this SUBMITS, and persisting a returned delta stays behind the
   * confirmation gate (7.13.5) on the approve route.
   */
  async submitContextual(
    prompt: string,
    targetKeys: readonly string[],
    ctx: ProjectContext,
  ): Promise<{ jobId: string }> {
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
        targetKeys: [...targetKeys],
        ...(code ? { code } : {}),
      },
      { userId: ctx.userId },
    );
  },

  /** The live channel for a contextual planning turn's job — the same 7.1.4 job
   *  stream every plan-edit surface relays, named for its caller so the panel's
   *  route reads as one seam. Browsers stream from CORE, never from motir-ai. */
  streamContextual(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
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

  /**
   * THE CONFIRMATION GATE (7.12.5 · MOTIR-911) — the ONE path by which a proposed
   * tree change becomes rows.
   *
   * `editedDelta` is the diff a human APPROVED in the review rail, which may
   * differ from what the job proposed (nodes re-titled, nodes excluded). There is
   * no auto-write path anywhere: nothing persists a plan delta except an explicit
   * call to this method, and each call applies EXACTLY the one diff it is handed —
   * a child expansion, a SIBLING addition and a PARENT re-plan all come through
   * here identically. (Omitting `editedDelta` approves the job's own delta
   * verbatim, which is still an explicit approve of that exact document.)
   *
   * Two phases, in this order, and the order is the contract:
   *
   *  1. **PRE-FLIGHT — nothing is written.** Edit permission (6.4) on the project
   *     that owns every node the delta touches; resolution of each referenced node
   *     WITHIN that project (a foreign one simply does not resolve — 404-not-403,
   *     no existence leak); the done-work immutability rule over EVERY update
   *     target; and an INDEPENDENT re-validation of the grammar
   *     (`lib/ai/planDeltaGate.ts`) — the client-submitted delta is never trusted
   *     to have been checked by whoever produced it. Any violation throws before
   *     the transaction opens, so a rejected delta leaves the tree byte-identical.
   *
   *  2. **PERSIST — ONE transaction.** The whole approved delta commits or rolls
   *     back together; a node-level failure never leaves a half-applied tree. This
   *     composes the tx-aware work-item LEAVES (`workItemRepository`,
   *     `workItemRevisionsService`, `projectRepository.allocateWorkItemNumber`,
   *     `watchersService.autoWatch`, `autoRelateWorkItemMentions`) rather than
   *     calling `workItemsService.createWorkItem` / `updateWorkItem`, because those
   *     own their OWN `db.$transaction` and Prisma cannot nest interactive
   *     transactions — calling them per op is exactly what made the previous
   *     implementation non-atomic. This is the same composition
   *     `plansService.materialize` uses for approve-a-Plan, at the layer
   *     transactional composition actually allows.
   *
   * An empty (or all-excluded) delta is a valid no-op: it returns empty arrays and
   * writes nothing — no transaction is even opened.
   */
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

    const svcCtx: ServiceContext = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    // ── Phase 1: pre-flight ────────────────────────────────────────────────────
    // 6.4 across EVERY node the delta touches. A delta is single-project by
    // construction (every op resolves against `ctx.projectId` below), and the
    // project IS the grant unit for edit — so one assert covers the anchored item,
    // its siblings and its parent alike. A parent re-plan therefore requires edit
    // on the subtree exactly as a child expansion does; there is no weaker path
    // for a node further from the anchor.
    await projectAccessService.assertCanEdit(ctx.projectId, svcCtx);

    // Resolve every EXISTING node the delta names, in this project only. A key
    // from another tenant/project does not resolve and reads as absent.
    const existingByKey = new Map<string, WorkItem>();
    for (const key of collectReferencedKeys(delta)) {
      const row = await workItemRepository.findByIdentifier(ctx.projectId, key);
      if (!row) throw new PlanDeltaApproveError(`Work item ${key} not found`);
      existingByKey.set(key, row);
    }

    // Done-work immutability, over EVERY update target BEFORE any write — the
    // planner already locks completed nodes (7.4.4); core re-checks because the
    // approved delta arrives from the client. Re-checked again under the row lock
    // inside the transaction, where a concurrent transition could have landed.
    const terminalKeys = await workflowsService.getTerminalStatusKeys(
      ctx.projectId,
      ctx.workspaceId,
    );
    for (const op of delta.operations) {
      if (op.op !== 'update') continue;
      if (terminalKeys.has(existingByKey.get(op.targetKey)!.status)) {
        throw new PlanDeltaImmutabilityError(
          `Work item ${op.targetKey} is in a terminal status and cannot be modified`,
        );
      }
    }

    // The independent grammar re-validation (throws 400 on an illegal edge, a
    // dangling/cyclic intra-delta ref, or a bad enum) + the topological create
    // order the persist pass sweeps in.
    const gated = gatePlanDelta(delta, existingByKey);

    // A no-op approve never opens a transaction.
    if (gated.creates.length === 0 && gated.updates.length === 0) {
      return { created: [], updated: [], unchanged: [] };
    }

    const statusKey = await workflowsService.getInitialStatusKey(ctx.projectId, ctx.workspaceId);
    if (statusKey == null) throw new NoInitialStatusError(ctx.projectId);

    // ── Phase 2: persist, atomically ───────────────────────────────────────────
    const { created, updated, createdIds } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId },
      async (tx) => {
        const project = await projectRepository.findById(ctx.projectId, tx);
        if (!project) throw new ProjectNotFoundError(ctx.projectId);

        const created: string[] = [];
        const createdIds: string[] = [];
        const updated: string[] = [];
        // ref → the CREATED row's DATABASE id: `parentId` is a DB id, so an
        // in-delta `parentRef` must resolve to one. The gate ordered the creates
        // so a referenced parent is always already in this map.
        const refToId = new Map<string, string>();

        if (gated.creates.length > 0) {
          // §4 work-item cap (8.1.11) — the same ceiling the interactive create
          // enforces, taken ONCE for the whole delta and under the org row lock.
          const capOrgId = await workspaceRepository.findOrganizationId(ctx.workspaceId, tx);
          if (capOrgId) await entitlementsService.assertWithinWorkItemCap(capOrgId, tx);
        }

        for (const op of gated.creates) {
          const number = await projectRepository.allocateWorkItemNumber(ctx.projectId, tx);
          // Re-read the prefix under the lock `allocateWorkItemNumber` just took:
          // a racing `changeKey` (Story 6.8) could have committed a new project
          // identifier, and minting from the pre-tx snapshot would stamp a stale
          // prefix. The same re-read `workItemsService.createWorkItem` does.
          const refreshed = await projectRepository.findById(ctx.projectId, tx);
          const prefix = refreshed?.identifier ?? project.identifier;
          const identifier = `${prefix}-${number}`;

          const parentId = op.parentKey
            ? existingByKey.get(op.parentKey)!.id
            : op.parentRef
              ? (refToId.get(op.parentRef) ?? null)
              : null;

          // Bare `MOTIR-N` refs in the body become canonical link tokens so the
          // materialized description chips (5.8.6) instead of staying plain text.
          const [descriptionMd] = await normalizeBodyRefs(
            {
              projectId: ctx.projectId,
              projectIdentifier: prefix,
              fields: [op.fields.descriptionMd],
            },
            tx,
          );

          const siblings = await workItemRepository.findSiblings(ctx.projectId, parentId, tx);
          const position = keyForAppend(
            siblings.length ? siblings[siblings.length - 1]!.position : null,
          );
          const lastRank = await workItemRepository.findBoundaryBacklogRank(
            ctx.projectId,
            ctx.workspaceId,
            null,
            'max',
            tx,
          );

          const data: Prisma.WorkItemUncheckedCreateInput = {
            workspaceId: ctx.workspaceId,
            projectId: ctx.projectId,
            parentId,
            kind: op.kind,
            key: number,
            identifier,
            title: op.fields.title,
            descriptionMd: descriptionMd ?? null,
            status: statusKey,
            ...(op.fields.priority
              ? { priority: op.fields.priority as Prisma.WorkItemUncheckedCreateInput['priority'] }
              : {}),
            reporterId: ctx.userId,
            // The type rides through validated (leaf-only, checked in the gate);
            // `executor` stays null, as the pre-atomic implementation passed it.
            type: (op.fields.type as Prisma.WorkItemUncheckedCreateInput['type']) ?? null,
            estimateMinutes: op.fields.estimateMinutes ?? null,
            position,
            backlogRank: keyForAppend(lastRank),
          };

          const row = await workItemRepository.create(data, tx);
          await workItemRevisionsService.recordRevision(
            {
              workItemId: row.id,
              changedById: ctx.userId,
              changeKind: 'created',
              diff: buildCreatedDiff(row),
            },
            tx,
          );
          // The creator watches what they created (5.4.4) and birth-body mentions
          // auto-relate (5.8.3) — both in THIS transaction, as the interactive
          // create does, so an approved node is born with the same edges.
          await watchersService.autoWatch(row.id, ctx.userId, tx);
          await autoRelateWorkItemMentions(
            {
              source: {
                id: row.id,
                workspaceId: ctx.workspaceId,
                projectId: ctx.projectId,
                projectIdentifier: prefix,
              },
              text: [row.title, row.descriptionMd].filter(Boolean).join('\n'),
              ctx: svcCtx,
            },
            tx,
          );

          if (op.ref) refToId.set(op.ref, row.id);
          created.push(row.identifier);
          createdIds.push(row.id);
        }

        for (const op of gated.updates) {
          const targetId = existingByKey.get(op.targetKey)!.id;
          // Lock + RE-READ inside the transaction before deriving the diff
          // (notes.html mistake #35): a concurrent writer could have moved this
          // row — including INTO a terminal status — since the pre-flight read, so
          // both the `from` values and the immutability verdict are taken here.
          const locked = await workItemRepository.lockById(targetId, tx);
          if (!locked) throw new PlanDeltaApproveError(`Work item ${op.targetKey} not found`);
          const current = await workItemRepository.findById(targetId, tx);
          /* istanbul ignore next -- lockById above proved the row exists in this tx */
          if (!current) throw new PlanDeltaApproveError(`Work item ${op.targetKey} not found`);
          if (terminalKeys.has(current.status)) {
            throw new PlanDeltaImmutabilityError(
              `Work item ${op.targetKey} is in a terminal status and cannot be modified`,
            );
          }

          const patch: Prisma.WorkItemUncheckedUpdateInput = {};
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          const prefix = current.identifier.slice(
            0,
            current.identifier.length - String(current.key).length - 1,
          );

          if (op.fields.title !== undefined && op.fields.title !== current.title) {
            patch.title = op.fields.title;
            diff.title = { from: current.title, to: op.fields.title };
          }
          const [normalizedDescriptionMd] = await normalizeBodyRefs(
            {
              projectId: ctx.projectId,
              projectIdentifier: prefix,
              fields: [op.fields.descriptionMd],
            },
            tx,
          );
          if (
            normalizedDescriptionMd !== undefined &&
            normalizedDescriptionMd !== current.descriptionMd
          ) {
            patch.descriptionMd = normalizedDescriptionMd;
            diff.descriptionMd = { from: current.descriptionMd, to: normalizedDescriptionMd };
          }
          if (op.fields.type !== undefined && op.fields.type !== current.type) {
            patch.type = op.fields.type as WorkItemTypeDto | null;
            diff.type = { from: current.type, to: op.fields.type };
          }
          if (op.fields.priority !== undefined && op.fields.priority !== current.priority) {
            patch.priority = op.fields.priority as WorkItemPriorityDto;
            diff.priority = { from: current.priority, to: op.fields.priority };
          }
          if (
            op.fields.estimateMinutes !== undefined &&
            op.fields.estimateMinutes !== current.estimateMinutes
          ) {
            patch.estimateMinutes = op.fields.estimateMinutes;
            diff.estimateMinutes = { from: current.estimateMinutes, to: op.fields.estimateMinutes };
          }

          if (Object.keys(patch).length > 0) {
            await workItemRepository.update(targetId, patch, tx);
            await workItemRevisionsService.recordRevision(
              { workItemId: targetId, changedById: ctx.userId, changeKind: 'updated', diff },
              tx,
            );
          }
          // A supplied-but-identical patch is a processed no-op, not a failure —
          // it still reports as applied (an all-excluded delta is valid).
          updated.push(op.targetKey);
        }

        return { created, updated, createdIds };
      },
    );

    // Post-commit, never inside the tx — a rollback must not have notified. The
    // automation `created` trigger (6.6.2) fires for each node the approve landed.
    for (const workItemId of createdIds) {
      await sendEvent('work-item/created', {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        workItemId,
        actorId: ctx.userId,
      });
    }

    return { created, updated, unchanged: [] };
  },
};

/** The created-row state as a `{ from: null, to }` revision diff — the shape
 *  `workItemsService`'s `buildCreatedDiff` and `plansService`'s `buildAddDiff`
 *  emit, so an approved node's History renders through the already-registered
 *  activity dispositions (lib/activity/renderers.ts) with no new key. */
function buildCreatedDiff(row: WorkItem): Record<string, { from: null; to: unknown }> {
  const diff: Record<string, { from: null; to: unknown }> = {
    title: { from: null, to: row.title },
    kind: { from: null, to: row.kind },
    status: { from: null, to: row.status },
  };
  if (row.descriptionMd != null) diff.descriptionMd = { from: null, to: row.descriptionMd };
  if (row.type != null) diff.type = { from: null, to: row.type };
  if (row.estimateMinutes != null) diff.estimateMinutes = { from: null, to: row.estimateMinutes };
  return diff;
}
