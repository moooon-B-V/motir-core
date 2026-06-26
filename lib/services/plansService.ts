import { Prisma, type Plan, type PlanItem, type WorkItem, type WorkItemKind } from '@prisma/client';

import { keyForAppend } from '@/lib/workItems/positioning';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';

import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';

import { ProjectNotFoundError } from '@/lib/projects/errors';
import { NoInitialStatusError } from '@/lib/workItems/errors';
import {
  InvalidProposalError,
  PlanItemNotFoundError,
  PlanItemTargetMissingError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';

import type {
  CreatePlanInput,
  ListPlansOptions,
  PlanDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanListPageDto,
  PlanWithItemsDto,
  ProposalInput,
  UpdateProposalInput,
} from '@/lib/dto/plans';
import { toPlanDto, toPlanItemDto, toPlanWithItemsDto } from '@/lib/mappers/planMappers';

// The AI-planning Plan substrate (Story 7.21 · MOTIR-1336) — the foundation
// every planner produces into. A `Plan` bundles proposed `PlanItem` operations
// the user reviews and approves/declines as ONE unit. A PlanItem is a PROPOSAL,
// never a row in the work-item tree: an `add` lives only as a PlanItem (no
// WorkItem until approve), and `modify`/`remove` leave their targets untouched
// until approve. On approve the items MATERIALIZE; on decline they drop with
// the tree untouched.
//
// 4-layer (CLAUDE.md): this service owns the transactions + the materialize
// orchestration; every DB op goes through a repository. NOTE — the materialize
// composes the work-item LEAF repositories (`workItemRepository`,
// `workItemLinkRepository`, `workItemRevisionsService`,
// `projectRepository.allocateWorkItemNumber`) directly INSIDE the approve
// transaction rather than calling `workItemsService.createWorkItem` /
// `updateWorkItem`, because those service methods own their OWN
// `db.$transaction` and Prisma cannot nest interactive transactions — calling
// them here would break the "approve applies in ONE transaction" guarantee.
// Composing the tx-aware leaves is the architecturally correct way to materialize
// atomically (the card's `workItemsService.create(proposedFields)` intent, at the
// layer transactional composition actually allows).

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

// The intra-plan temp-ref prefix: a `parentRef` / `blockedByRef` of the form
// `planItem:<planItemId>` points at another `add` in the SAME plan (resolved to
// the created work-item id at materialize). Exported so the pre-commit
// projection engine (7.28.1 / planValidityService) resolves refs through the
// EXACT same contract materialize uses — no second source of truth.
export const TEMP_REF_PREFIX = 'planItem:';

function validateProposal(p: ProposalInput): void {
  if (p.op === 'add') {
    if (!p.proposedFields || !p.proposedFields.title?.trim()) {
      throw new InvalidProposalError('An `add` proposal requires proposedFields.title.');
    }
  } else if (p.op === 'modify') {
    if (!p.workItemId) throw new InvalidProposalError('A `modify` proposal requires workItemId.');
    if (!p.patch) throw new InvalidProposalError('A `modify` proposal requires a patch.');
  } else {
    // remove
    if (!p.workItemId) throw new InvalidProposalError('A `remove` proposal requires workItemId.');
  }
}

/**
 * Apply an `UpdateProposalInput` over an `add`'s existing `proposedFields`
 * (7.21.6 · MOTIR-1370). SPARSE: only the keys PRESENT in the input change; an
 * absent key (`undefined`) is left as-is, an explicit `null` on a nullable field
 * clears it. `executor` is never touched (not in the editable set). The result is
 * re-validated by the caller (title must stay non-empty).
 */
function mergeProposedFields(
  current: PlanItemProposedFields,
  input: UpdateProposalInput,
): PlanItemProposedFields {
  const next: PlanItemProposedFields = { ...current };
  if (input.title !== undefined) next.title = input.title;
  if (input.kind !== undefined) next.kind = input.kind;
  if (input.descriptionMd !== undefined) next.descriptionMd = input.descriptionMd;
  if (input.type !== undefined) next.type = input.type;
  if (input.priority !== undefined) next.priority = input.priority;
  return next;
}

/** A created-row revision diff ({ field: { from: null, to } }) for a materialized add. */
function buildAddDiff(row: WorkItem): Record<string, { from: null; to: unknown }> {
  const diff: Record<string, { from: null; to: unknown }> = {
    title: { from: null, to: row.title },
    kind: { from: null, to: row.kind },
    status: { from: null, to: row.status },
  };
  if (row.descriptionMd != null) diff.descriptionMd = { from: null, to: row.descriptionMd };
  if (row.type != null) diff.type = { from: null, to: row.type };
  if (row.executor != null) diff.executor = { from: null, to: row.executor };
  return diff;
}

/**
 * Topologically order `add` PlanItems so a child (whose `parentRef` is an
 * intra-plan temp-ref `planItem:<id>`) is created AFTER its parent — the parent
 * work item must exist when the child is inserted (a subtask cannot be
 * transiently parent-less under the kind-parent DB trigger). Refs to real ids /
 * null impose no ordering. Throws on a missing intra-plan parent or a cycle.
 */
function topoOrderAdds(adds: PlanItem[]): PlanItem[] {
  const byId = new Map(adds.map((a) => [a.id, a]));
  const ordered: PlanItem[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (a: PlanItem): void => {
    if (visited.has(a.id)) return;
    if (visiting.has(a.id)) throw new UnresolvedPlanRefError(`${TEMP_REF_PREFIX}${a.id}`);
    visiting.add(a.id);
    if (a.parentRef && a.parentRef.startsWith(TEMP_REF_PREFIX)) {
      const parentId = a.parentRef.slice(TEMP_REF_PREFIX.length);
      const parent = byId.get(parentId);
      if (!parent) throw new UnresolvedPlanRefError(a.parentRef);
      visit(parent);
    }
    visiting.delete(a.id);
    visited.add(a.id);
    ordered.push(a);
  };

  for (const a of adds) visit(a);
  return ordered;
}

/**
 * Apply every PlanItem of a (locked, `planned`) plan inside the caller's
 * approve transaction. `add` → MATERIALIZE a WorkItem (intra-plan refs
 * resolved); `modify` → update the target (same id, ONE revision logged);
 * `remove` → archive the target. Runs entirely on `tx`.
 */
async function materialize(
  items: PlanItem[],
  plan: Plan,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const project = await projectRepository.findById(plan.projectId, tx);
  if (!project) throw new ProjectNotFoundError(plan.projectId);
  const statusKey = await workflowsService.getInitialStatusKey(plan.projectId, ctx.workspaceId);
  if (statusKey == null) throw new NoInitialStatusError(plan.projectId);

  const adds = items.filter((i) => i.op === 'add');
  const planItemToWorkItem = new Map<string, string>();

  const resolveRef = (ref: string): string => {
    if (ref.startsWith(TEMP_REF_PREFIX)) {
      const target = planItemToWorkItem.get(ref.slice(TEMP_REF_PREFIX.length));
      if (!target) throw new UnresolvedPlanRefError(ref);
      return target;
    }
    return ref;
  };

  // Pass 1 — create each add's WorkItem (parent resolved at insert, in topo order).
  for (const item of topoOrderAdds(adds)) {
    const pf = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
    const kind = (pf.kind as WorkItemKind | undefined) ?? 'task';
    const parentId = item.parentRef ? resolveRef(item.parentRef) : null;

    const number = await projectRepository.allocateWorkItemNumber(plan.projectId, tx);
    // Re-read the identifier prefix under the lock allocateWorkItemNumber took
    // (a racing `changeKey` could have committed a new prefix — the same re-read
    // workItemsService.createWorkItem does).
    const refreshed = await projectRepository.findById(plan.projectId, tx);
    const prefix = refreshed?.identifier ?? project.identifier;
    const identifier = `${prefix}-${number}`;

    const siblings = await workItemRepository.findSiblings(plan.projectId, parentId, tx);
    const position = keyForAppend(siblings.length ? siblings[siblings.length - 1]!.position : null);
    const lastRank = await workItemRepository.findBoundaryBacklogRank(
      plan.projectId,
      ctx.workspaceId,
      null,
      'max',
      tx,
    );
    const backlogRank = keyForAppend(lastRank);

    const data: Prisma.WorkItemUncheckedCreateInput = {
      workspaceId: ctx.workspaceId,
      projectId: plan.projectId,
      parentId,
      kind,
      key: number,
      identifier,
      title: pf.title,
      descriptionMd: pf.descriptionMd ?? null,
      status: statusKey,
      ...(pf.priority
        ? { priority: pf.priority as Prisma.WorkItemUncheckedCreateInput['priority'] }
        : {}),
      reporterId: ctx.userId,
      type: (pf.type as Prisma.WorkItemUncheckedCreateInput['type']) ?? null,
      executor: (pf.executor as Prisma.WorkItemUncheckedCreateInput['executor']) ?? null,
      position,
      backlogRank,
    };

    const created = await workItemRepository.create(data, tx);
    planItemToWorkItem.set(item.id, created.id);
    await planItemRepository.setWorkItemId(item.id, created.id, tx);
    await workItemRevisionsService.recordRevision(
      {
        workItemId: created.id,
        changedById: ctx.userId,
        changeKind: 'created',
        diff: buildAddDiff(created),
      },
      tx,
    );
  }

  // Pass 2 — blocked-by edges for the adds (all add targets now exist).
  for (const item of adds) {
    const fromId = planItemToWorkItem.get(item.id)!;
    for (const ref of item.blockedByRefs) {
      await workItemLinkRepository.create(
        {
          workspaceId: ctx.workspaceId,
          fromId,
          toId: resolveRef(ref),
          kind: 'is_blocked_by',
          createdById: ctx.userId,
        },
        tx,
      );
    }
  }

  // modify + remove against existing targets (locked + re-read inside the tx).
  for (const item of items) {
    if (item.op === 'modify') {
      await applyModify(item, ctx, resolveRef, tx);
    } else if (item.op === 'remove') {
      if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
      const locked = await workItemRepository.lockById(item.workItemId, tx);
      if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
      await workItemRepository.archive(item.workItemId, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId: item.workItemId, changedById: ctx.userId, changeKind: 'archived', diff: {} },
        tx,
      );
    }
  }
}

/** A single `modify` materialize: patch the target (same id), one revision. */
async function applyModify(
  item: PlanItem,
  ctx: ServiceContext,
  resolveRef: (ref: string) => string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
  const locked = await workItemRepository.lockById(item.workItemId, tx);
  if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
  const current = await workItemRepository.findById(item.workItemId, tx);
  if (!current) throw new PlanItemTargetMissingError(item.workItemId);

  const patch = (item.patch ?? {}) as unknown as PlanItemPatch;
  const update: Prisma.WorkItemUncheckedUpdateInput = {};
  // Holds per-field { from, to } cells AND the `links` edge-change cell
  // ({ added, removed }) — the work-item revision diff is a heterogeneous map.
  const diff: Record<string, unknown> = {};

  if (patch.title !== undefined && patch.title !== current.title) {
    update.title = patch.title;
    diff.title = { from: current.title, to: patch.title };
  }
  if (patch.descriptionMd !== undefined && patch.descriptionMd !== current.descriptionMd) {
    update.descriptionMd = patch.descriptionMd;
    diff.descriptionMd = { from: current.descriptionMd, to: patch.descriptionMd };
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    update.priority = patch.priority as Prisma.WorkItemUncheckedUpdateInput['priority'];
    diff.priority = { from: current.priority, to: patch.priority };
  }
  if (patch.type !== undefined && patch.type !== current.type) {
    update.type = patch.type as Prisma.WorkItemUncheckedUpdateInput['type'];
    diff.type = { from: current.type, to: patch.type };
  }
  if (Object.keys(update).length > 0) {
    await workItemRepository.update(item.workItemId, update, tx);
  }

  // Edge changes: add/remove `is_blocked_by` links (the target is the `from`).
  // Recorded under the EXISTING `links` revision-diff key + shape that
  // workItemsService uses ({ added/removed: [{ toId, kind }] }) — so the activity
  // feed renders them through the already-registered `links` disposition
  // (lib/activity/renderers.ts) rather than a new, undispositioned key.
  const linkAdded: Array<{ toId: string; kind: string }> = [];
  for (const ref of patch.blockedByAdd ?? []) {
    const toId = resolveRef(ref);
    await workItemLinkRepository.create(
      {
        workspaceId: ctx.workspaceId,
        fromId: item.workItemId,
        toId,
        kind: 'is_blocked_by',
        createdById: ctx.userId,
      },
      tx,
    );
    linkAdded.push({ toId, kind: 'is_blocked_by' });
  }
  const linkRemoved: Array<{ toId: string; kind: string }> = [];
  for (const ref of patch.blockedByRemove ?? []) {
    const toId = resolveRef(ref);
    const link = await workItemLinkRepository.findReciprocal(
      item.workItemId,
      toId,
      'is_blocked_by',
      tx,
    );
    if (link) {
      await workItemLinkRepository.delete(link.id, tx);
      linkRemoved.push({ toId, kind: 'is_blocked_by' });
    }
  }
  if (linkAdded.length > 0 || linkRemoved.length > 0) {
    diff.links = {
      ...(linkAdded.length > 0 ? { added: linkAdded } : {}),
      ...(linkRemoved.length > 0 ? { removed: linkRemoved } : {}),
    };
  }

  // ONE revision for the whole modify (same id — lands as a single entry in the
  // existing work-item revision/activity log; identity is never re-minted).
  await workItemRevisionsService.recordRevision(
    { workItemId: item.workItemId, changedById: ctx.userId, changeKind: 'updated', diff },
    tx,
  );
}

export const plansService = {
  /**
   * Open a `generating` Plan — the producer (7.4 generation / 7.11 re-planning)
   * calls this before emitting proposals. No WorkItem is created.
   */
  async createPlan(
    projectId: string,
    input: CreatePlanInput,
    ctx: ServiceContext,
  ): Promise<PlanDto> {
    await projectAccessService.assertCanEdit(projectId, ctx);
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) =>
        planRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            status: 'generating',
            title: input.title ?? null,
            summary: input.summary ?? null,
            sourceJobId: input.sourceJobId ?? null,
          },
          tx,
        ),
    );
    return toPlanDto(row, 0);
  },

  /**
   * Append proposed `add`/`modify`/`remove` PlanItems to a `generating` plan
   * (the producer calls this per node / per batch). NO WorkItem is created here.
   * The plan row is locked + its status re-read so an append racing a
   * `markPlanned` is rejected once the plan leaves `generating`.
   */
  async addProposals(
    planId: string,
    proposals: ProposalInput[],
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);
    if (plan.status !== 'generating') throw new PlanNotGeneratingError(planId, plan.status);
    proposals.forEach(validateProposal);

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'generating') throw new PlanNotGeneratingError(planId, fresh.status);

        for (const p of proposals) {
          const data: Prisma.PlanItemUncheckedCreateInput = {
            workspaceId: ctx.workspaceId,
            planId,
            op: p.op,
            workItemId: p.op === 'add' ? null : (p.workItemId ?? null),
            parentRef: p.parentRef ?? null,
            blockedByRefs: p.blockedByRefs ?? [],
            baseRevision: p.baseRevision ?? null,
            ...(p.op === 'add' && p.proposedFields
              ? { proposedFields: p.proposedFields as unknown as Prisma.InputJsonValue }
              : {}),
            ...(p.op === 'modify' && p.patch
              ? { patch: p.patch as unknown as Prisma.InputJsonValue }
              : {}),
          };
          await planItemRepository.create(data, tx);
        }
        const allItems = await planItemRepository.findByPlan(planId, tx);
        return { row: fresh, items: allItems };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /** Mark the generation frontier complete: `generating` → `planned`. */
  async markPlanned(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    const { row, count } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'generating') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'generating');
        }
        const updated = await planRepository.update(
          planId,
          { status: 'planned', plannedAt: new Date() },
          tx,
        );
        const n = await planItemRepository.countByPlan(planId, tx);
        return { row: updated, count: n };
      },
    );
    return toPlanDto(row, count);
  },

  /** A project's plans, newest first, cursor-paginated (the list view). */
  async listPlans(
    projectId: string,
    ctx: ServiceContext,
    opts: ListPlansOptions = {},
  ): Promise<PlanListPageDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const limit = clampLimit(opts.limit);
    const rows = await planRepository.listByProject(
      projectId,
      ctx.workspaceId,
      limit + 1,
      opts.cursor ?? null,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const counts = await planItemRepository.countByPlanIds(page.map((p) => p.id));
    return {
      plans: page.map((p) => toPlanDto(p, counts.get(p.id) ?? 0)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  },

  /** A plan + its bundled proposal items (the detail view). The lifecycle
   *  timestamps + decider on the returned plan ARE the history surface. */
  async getPlan(planId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    const items = await planItemRepository.findByPlan(planId);
    return toPlanWithItemsDto(plan, items);
  },

  /**
   * Edit a proposed `add` of a `planned` plan IN PLACE (7.21.6 · MOTIR-1370) —
   * the review surface's inline edit. Patches the `add`'s `proposedFields`
   * (title/kind/priority/type/description); NO WorkItem is created (an `add`
   * stays a proposal until approve materializes it). The plan row is locked + its
   * status re-read, so an edit racing an `approve`/`decline` is rejected once the
   * plan leaves `planned` (`PlanNotInExpectedStatusError`, the same one-shot guard
   * approve uses). Only an `add` is editable — `modify`/`remove` target existing
   * items, so editing one is an `InvalidProposalError`. Returns the full
   * `PlanWithItemsDto` so the caller reflects the change without a second read.
   */
  async updateProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'planned') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
        }
        const item = await planItemRepository.findById(planItemId, tx);
        if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);
        if (item.op !== 'add') {
          throw new InvalidProposalError(
            'Only an `add` proposal can be edited; modify/remove target existing items.',
          );
        }
        const current = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
        const next = mergeProposedFields(current, input);
        if (!next.title?.trim()) {
          throw new InvalidProposalError('An `add` proposal requires a non-empty title.');
        }
        await planItemRepository.update(
          planItemId,
          { proposedFields: next as unknown as Prisma.InputJsonValue },
          tx,
        );
        const allItems = await planItemRepository.findByPlan(planId, tx);
        return { row: fresh, items: allItems };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /**
   * Approve a `planned` plan: in ONE transaction set `approved` +
   * decidedAt/decidedById, then MATERIALIZE every PlanItem (add → create,
   * modify → update same id, remove → archive). The plan row is locked + its
   * status re-read first, so two concurrent approves resolve to exactly one
   * materialize — the loser observes `approved` and throws
   * `PlanNotInExpectedStatusError` (the atomic one-shot guard).
   */
  async approvePlan(planId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'planned') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
        }
        const proposals = await planItemRepository.findByPlan(planId, tx);
        await materialize(proposals, fresh, ctx, tx);
        const updated = await planRepository.update(
          planId,
          { status: 'approved', decidedAt: new Date(), decidedById: ctx.userId },
          tx,
        );
        // Re-read so the returned items carry the written-back work-item ids.
        const finalItems = await planItemRepository.findByPlan(planId, tx);
        return { row: updated, items: finalItems };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /**
   * Decline a `planned` plan: set `declined` + decidedAt/decidedById and DROP
   * all PlanItems. The tree was NEVER touched (adds never materialized;
   * modify/remove targets untouched) → a clean no-op on the work-item tree.
   */
  async declinePlan(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'planned') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
        }
        await planItemRepository.deleteByPlan(planId, tx);
        return planRepository.update(
          planId,
          { status: 'declined', decidedAt: new Date(), decidedById: ctx.userId },
          tx,
        );
      },
    );
    return toPlanDto(row, 0);
  },
};

// Re-export the DTO `toPlanItemDto` use so the unused-import linter doesn't trip
// when a caller only needs the item mapper through the service module surface.
export { toPlanItemDto };
