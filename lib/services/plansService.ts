import { Prisma, type Plan, type PlanItem, type WorkItem, type WorkItemKind } from '@prisma/client';

import { keyForAppend } from '@/lib/workItems/positioning';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { rewriteIntraPlanRefs } from '@/lib/mentions/workItemRefs';

import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';

import { ProjectNotFoundError } from '@/lib/projects/errors';
import { NoInitialStatusError } from '@/lib/workItems/errors';
import { validateStoryPoints, validateEstimateMinutes } from '@/lib/estimation/validate';
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

/**
 * Validate the leaf SIZING of an `add`'s proposed fields (MOTIR-1433) — the
 * SAME rules the create path applies: a Fibonacci-range story-point value
 * (`validateStoryPoints`) and a non-negative integer-minute time estimate
 * (`validateEstimateMinutes`). Both `undefined`/`null` pass (an unsized or
 * non-leaf `add`). Throws `InvalidEstimateError` on a malformed value, so a bad
 * size is rejected at the proposal boundary rather than silently reaching the
 * `estimateMinutes` / `storyPoints` columns at materialize (which bypasses the
 * MCP/route Zod boundary the human-create path validates behind).
 */
function validateProposedSizing(pf: PlanItemProposedFields): void {
  validateStoryPoints(pf.storyPoints ?? null);
  validateEstimateMinutes(pf.estimateMinutes ?? null);
}

function validateProposal(p: ProposalInput): void {
  if (p.op === 'add') {
    if (!p.proposedFields || !p.proposedFields.title?.trim()) {
      throw new InvalidProposalError('An `add` proposal requires proposedFields.title.');
    }
    validateProposedSizing(p.proposedFields);
  } else if (p.op === 'modify') {
    if (!p.workItemId) throw new InvalidProposalError('A `modify` proposal requires workItemId.');
    if (!p.patch) throw new InvalidProposalError('A `modify` proposal requires a patch.');
    // A `modify` may RE-SCOPE the target's sizing (MOTIR-1532) — validate the
    // patched-in points/estimate at the boundary, the SAME rules the `add` path
    // applies (`validateProposedSizing`), so a malformed re-scope is rejected here
    // (422) rather than reaching the `storyPoints`/`estimateMinutes` columns at
    // materialize. Absent (`undefined`/`null`) passes — a modify that leaves
    // sizing alone, or an explicit `null` that clears it.
    validateStoryPoints(p.patch.storyPoints ?? null);
    validateEstimateMinutes(p.patch.estimateMinutes ?? null);
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
  if (input.storyPoints !== undefined) next.storyPoints = input.storyPoints;
  if (input.estimateMinutes !== undefined) next.estimateMinutes = input.estimateMinutes;
  if (input.explanationMd !== undefined) next.explanationMd = input.explanationMd;
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
  // AI-drafted explanation (MOTIR-850) — record it when set (null = none is
  // omitted). `explanationMd` has an `editedField()` disposition in
  // lib/activity/renderers.ts, so the created-revision feed renders it; the
  // `explanationSource` metadata column is deliberately NOT diffed (no renderer
  // disposition — the same rule the `modify` path follows for undispositioned keys).
  if (row.explanationMd != null) diff.explanationMd = { from: null, to: row.explanationMd };
  if (row.type != null) diff.type = { from: null, to: row.type };
  if (row.executor != null) diff.executor = { from: null, to: row.executor };
  // Leaf sizing (MOTIR-1433) — mirror `buildCreatedDiff`: record the estimate
  // when set (null = unestimated is omitted). `storyPoints` is a Prisma Decimal,
  // so record it numeric (the same `Number(...)` shape estimationService logs).
  if (row.estimateMinutes != null) diff.estimateMinutes = { from: null, to: row.estimateMinutes };
  if (row.storyPoints != null) diff.storyPoints = { from: null, to: Number(row.storyPoints) };
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
  // The created adds, collected for the post-creation body pass (Pass 3) — the
  // intra-plan item-link tokens in a body can reference a sibling created LATER
  // (a forward ref), so resolving them must wait until every add's id exists.
  const createdAdds: Array<{ created: WorkItem; prefix: string }> = [];

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

    // Normalize bare REAL work-item refs in the generated description AND the
    // AI-drafted explanation (MOTIR-850) to canonical link tokens (bug MOTIR-1440)
    // so a materialized body chips (5.8.6) rather than staying plain text — the
    // same write-path rule the service create/update applies (it normalizes both
    // `descriptionMd` and `explanationMd`), here on the inlined materialize insert.
    // (Intra-plan temp refs are a separate concern, resolved at materialize by
    // the temp-ref → motir:<id> pass; this only resolves EXISTING bare keys.)
    const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
      {
        projectId: plan.projectId,
        projectIdentifier: prefix,
        fields: [pf.descriptionMd, pf.explanationMd],
      },
      tx,
    );

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
      descriptionMd: normalizedDescriptionMd ?? null,
      // AI-drafted explanation (MOTIR-850): flow `explanationMd` + its source onto
      // the created item. `explanationSource` is set ONLY when an explanation is
      // present — respect an explicit source the proposal carried, else default to
      // `ai_draft` (the generator drafted it); with no explanation the column stays
      // at its schema default (`user_authored`). Intra-plan temp-ref tokens in the
      // explanation are rewritten in Pass 3, like the description.
      explanationMd: normalizedExplanationMd ?? null,
      ...(typeof normalizedExplanationMd === 'string' && normalizedExplanationMd.trim() !== ''
        ? {
            explanationSource:
              (pf.explanationSource as Prisma.WorkItemUncheckedCreateInput['explanationSource']) ??
              'ai_draft',
          }
        : {}),
      status: statusKey,
      ...(pf.priority
        ? { priority: pf.priority as Prisma.WorkItemUncheckedCreateInput['priority'] }
        : {}),
      reporterId: ctx.userId,
      // Native PLANNING provenance (Story MOTIR-1685, docs/decisions/work-item-provenance.md
      // Decision 5): every item materialized from an approved plan was planned
      // NATIVELY by motir-ai. `source` is PINNED to `native` here (never read from
      // the proposal — this IS the native seam by construction, so a forged
      // `planningProvenance.source` can't downgrade the stamp); `harness` defaults
      // to `Motir` and `model` to null. DEFENSIVE: works before the motir-ai
      // producer (MOTIR-1690) ships — until proposals carry a model, items read
      // `native · Motir · null`; once they do, `model` starts populating. Merge
      // order between the producer and this consumer is therefore free.
      planningSource: 'native',
      planningHarness: pf.planningProvenance?.harness ?? 'Motir',
      planningModel: pf.planningProvenance?.model ?? null,
      type: (pf.type as Prisma.WorkItemUncheckedCreateInput['type']) ?? null,
      executor: (pf.executor as Prisma.WorkItemUncheckedCreateInput['executor']) ?? null,
      // Leaf sizing (MOTIR-1433): flow the validated point + minute estimates
      // onto the created item so the estimation gate satisfied on the proposal
      // survives materialize (Prisma accepts a number for the Decimal(6,2)
      // storyPoints column). Null when the `add` carried no estimate.
      estimateMinutes: pf.estimateMinutes ?? null,
      storyPoints: pf.storyPoints ?? null,
      position,
      backlogRank,
    };

    const created = await workItemRepository.create(data, tx);
    planItemToWorkItem.set(item.id, created.id);
    await planItemRepository.setWorkItemId(item.id, created.id, tx);
    // The `created` revision is recorded in Pass 3, after the body's intra-plan
    // item-link tokens are resolved — so the revision (and the live row) carry the
    // FINAL chip body, never the temp-ref form.
    createdAdds.push({ created, prefix });
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

  // Pass 3 — resolve intra-plan item-link tokens in each add's body, then
  // auto-relate + record the create revision (MOTIR-1418). Every add's WorkItem
  // id now exists, so a `[label](motir-ref:planItem:<id>)` token (the form the
  // 7.4 generator emits for a sibling it was still proposing) rewrites to a real
  // `[label](motir:<workItemId>)` — even a forward ref to a later sibling. After
  // the rewrite the body carries only real `motir:<id>` tokens, so the SAME
  // auto-relate-on-mention pass workItemsService runs at create (5.8.3) wires the
  // `relates_to` edges here too — materialize composes the leaf repos directly
  // (it cannot nest `workItemsService.createWorkItem`'s own transaction), so this
  // is where that hook belongs. ADD-only + idempotent, so it never duplicates or
  // downgrades the structural `is_blocked_by` edges from Pass 2.
  for (const { created, prefix } of createdAdds) {
    let finalRow = created;
    const { body: rewrittenDescription, unresolved } = rewriteIntraPlanRefs(
      created.descriptionMd ?? '',
      planItemToWorkItem,
    );
    // The AI-drafted explanation (MOTIR-850) follows the SAME item-link convention
    // as the description (rendered through the same markdown pipeline), so resolve
    // its intra-plan `motir-ref:planItem:<id>` tokens into real `motir:<id>` links
    // here too — even a forward ref to a sibling created later in this pass.
    const { body: rewrittenExplanation, unresolved: unresolvedExplanation } = rewriteIntraPlanRefs(
      created.explanationMd ?? '',
      planItemToWorkItem,
    );
    for (const ref of [...unresolved, ...unresolvedExplanation]) {
      // A dangling intra-plan ref is left inert (never dropped/crashed); surface
      // it — it means the generator referenced a sibling that wasn't proposed.
      console.warn(
        `[plansService.materialize] plan ${plan.id}: intra-plan ref planItem:${ref} in ${created.identifier} resolved to no item — left inert`,
      );
    }
    const bodyUpdate: Prisma.WorkItemUncheckedUpdateInput = {};
    if (rewrittenDescription !== (created.descriptionMd ?? '')) {
      bodyUpdate.descriptionMd = rewrittenDescription;
    }
    if (rewrittenExplanation !== (created.explanationMd ?? '')) {
      bodyUpdate.explanationMd = rewrittenExplanation;
    }
    if (Object.keys(bodyUpdate).length > 0) {
      finalRow = await workItemRepository.update(created.id, bodyUpdate, tx);
    }
    // Auto-relate mentions in BOTH the description AND the explanation (5.8.3) —
    // ADD-only + idempotent, so wiring `relates_to` from either body never
    // duplicates or downgrades the structural `is_blocked_by` edges from Pass 2.
    await autoRelateWorkItemMentions(
      {
        source: {
          id: finalRow.id,
          workspaceId: ctx.workspaceId,
          projectId: plan.projectId,
          projectIdentifier: prefix,
        },
        text: `${finalRow.descriptionMd ?? ''}\n${finalRow.explanationMd ?? ''}`,
        ctx,
      },
      tx,
    );
    await workItemRevisionsService.recordRevision(
      {
        workItemId: finalRow.id,
        changedById: ctx.userId,
        changeKind: 'created',
        diff: buildAddDiff(finalRow),
      },
      tx,
    );
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
  // Normalize bare REAL work-item refs in a modified description to canonical
  // link tokens (bug MOTIR-1440) so the patched body chips. The prefix is the
  // target's own identifier minus its `-<key>` suffix (same derivation the
  // quick-view read uses); a key that doesn't resolve is left plain.
  const prefix = current.identifier.slice(
    0,
    current.identifier.length - String(current.key).length - 1,
  );
  const [normalizedDescriptionMd] = await normalizeBodyRefs(
    { projectId: current.projectId, projectIdentifier: prefix, fields: [patch.descriptionMd] },
    tx,
  );
  if (normalizedDescriptionMd !== undefined && normalizedDescriptionMd !== current.descriptionMd) {
    update.descriptionMd = normalizedDescriptionMd;
    diff.descriptionMd = { from: current.descriptionMd, to: normalizedDescriptionMd };
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    update.priority = patch.priority as Prisma.WorkItemUncheckedUpdateInput['priority'];
    diff.priority = { from: current.priority, to: patch.priority };
  }
  if (patch.type !== undefined && patch.type !== current.type) {
    update.type = patch.type as Prisma.WorkItemUncheckedUpdateInput['type'];
    diff.type = { from: current.type, to: patch.type };
  }
  // Leaf sizing re-scope (MOTIR-1532) — the SAME point/estimate columns the `add`
  // path materializes, applied here as an in-place modify. `storyPoints` is a
  // Prisma Decimal, so compare + record the diff NUMERICALLY (the `Number(...)`
  // shape estimationService.setEstimate logs); `estimateMinutes` is a plain
  // nullable int. Both diff keys already have a `lib/activity/renderers.ts`
  // disposition (buildAddDiff / estimationService emit them), so the modify
  // revision renders with no new registry entry.
  if (patch.storyPoints !== undefined) {
    const from = current.storyPoints === null ? null : Number(current.storyPoints);
    if (patch.storyPoints !== from) {
      update.storyPoints = patch.storyPoints;
      diff.storyPoints = { from, to: patch.storyPoints };
    }
  }
  if (patch.estimateMinutes !== undefined && patch.estimateMinutes !== current.estimateMinutes) {
    update.estimateMinutes = patch.estimateMinutes;
    diff.estimateMinutes = { from: current.estimateMinutes, to: patch.estimateMinutes };
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

/**
 * Shared body of the two proposal-edit paths: lock the plan, assert it is in
 * `expectedStatus`, sparse-merge the `UpdateProposalInput` over the `add`'s
 * `proposedFields`, re-validate (non-empty title + leaf sizing), and persist —
 * NO WorkItem. The plan row is locked + its status re-read inside the tx, so an
 * edit racing the next lifecycle hop is rejected once the plan leaves
 * `expectedStatus`. Only an `add` is editable. The two callers differ ONLY in
 * which status the edit is legal from:
 *   • `updateProposal` — the user review edit, `planned`        (7.21.6 · MOTIR-1370)
 *   • `deepenProposal` — the generation-time deepen, `generating` (7.4.4a · MOTIR-1441)
 */
async function editAddProposal(
  planId: string,
  planItemId: string,
  input: UpdateProposalInput,
  ctx: ServiceContext,
  expectedStatus: 'planned' | 'generating',
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
      if (fresh.status !== expectedStatus) {
        throw new PlanNotInExpectedStatusError(planId, fresh.status, expectedStatus);
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
      // Re-validate sizing on the MERGED result (MOTIR-1433) so a patched-in bad
      // point/minute value is rejected here, the same as at create.
      validateProposedSizing(next);
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
  async markPlanned(
    planId: string,
    ctx: ServiceContext,
    opts: { productName?: string | null } = {},
  ): Promise<PlanDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    // The AI-suggested project name (MOTIR-1554/1551) rides the final append and
    // ONLY the onboarding generation. Persist it when present; a non-onboarding
    // (reconciliation) run sends none, so the column stays null and no rename
    // ever fires at approve. Trim + collapse to a clean value, else leave unset.
    const productName =
      typeof opts.productName === 'string' && opts.productName.trim().length > 0
        ? opts.productName.trim()
        : null;

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
          {
            status: 'planned',
            plannedAt: new Date(),
            ...(productName != null ? { productName } : {}),
          },
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
    return editAddProposal(planId, planItemId, input, ctx, 'planned');
  },

  /**
   * Deepen a proposed `add` while the plan is still `generating` (7.4.4a ·
   * MOTIR-1441) — the generation-time twin of `updateProposal`. The 7.4 issue-
   * tree generation handler (MOTIR-844) runs the titles-first strategy
   * (MOTIR-845): Phase 1 appends title-only `add`s via `addProposals`, then
   * Phase 2 PATCHES each one's `descriptionMd` (and finalises
   * type/priority/storyPoints/estimateMinutes) ONE AT A TIME — all BEFORE
   * `markPlanned` closes the frontier, so the plan is `generating`, not
   * `planned`. Identical to `updateProposal` (sparse merge, non-empty title +
   * sizing re-validation, add-only, row-locked one-shot) EXCEPT the legal status
   * is `generating`. NO WorkItem is created. Reached over the §4 job token via
   * `aiGenerationService.patchProposal`; the user-facing `updateProposal`
   * (`planned`) is unchanged.
   */
  async deepenProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'generating');
  },

  /**
   * Approve a `planned` plan: in ONE transaction set `approved` +
   * decidedAt/decidedById, then MATERIALIZE every PlanItem (add → create,
   * modify → update same id, remove → archive). The plan row is locked + its
   * status re-read first, so two concurrent approves resolve to exactly one
   * materialize — the loser observes `approved` and throws
   * `PlanNotInExpectedStatusError` (the atomic one-shot guard).
   */
  async approvePlan(
    planId: string,
    ctx: ServiceContext,
    opts: { provisionalProjectName?: string | null } = {},
  ): Promise<PlanWithItemsDto> {
    const plan = await planRepository.findById(planId, ctx.workspaceId);
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanEdit(plan.projectId, ctx);

    const { row, items, firstOnboarding, projectKey } = await withWorkspaceContext(
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
        // Read the project ONCE, before `markOnboardingRan` writes: its
        // pre-write `onboardingRanAt` gates the rename below, and its
        // `identifier` (the tenant projectKey) + the first-onboarding signal both
        // feed the fresh-establish convention trigger fired after the tx commits.
        const project = await projectRepository.findById(fresh.projectId, tx);
        // Name the onboarded project from the AI plan (MOTIR-1551). The onboarding
        // generation (MOTIR-1554) stamped a suggested `productName` on the Plan;
        // apply it here — but ONLY on the FIRST onboarding approve of a draft the
        // user hasn't already named. Read BEFORE `markOnboardingRan` below (which
        // sets `onboardingRanAt`), so `onboardingRanAt == null` is the "first
        // onboarding" gate; the `name === provisionalProjectName` check (the
        // caller passes the current-locale "Untitled project" placeholder) means a
        // user rename during review is never clobbered. A reconciliation re-plan
        // carries no `productName`, so it never reaches here. Best-effort: rename
        // failure would abort the tx, so keep it a plain guarded write. Done via
        // the repo in-tx — `renameProject` opens its own workspace context.
        if (
          fresh.productName &&
          fresh.productName.trim().length > 0 &&
          opts.provisionalProjectName
        ) {
          if (
            project &&
            project.onboardingRanAt == null &&
            project.name === opts.provisionalProjectName
          ) {
            await projectRepository.update(project.id, { name: fresh.productName.trim() }, tx);
          }
        }
        // Stamp the immutable onboarding-ran marker the FIRST time this project's
        // plan is approved + materialized (Subtask 7.4 / MOTIR-1264). The repo's
        // null-guarded write makes it set-once, so calling it on every approve is
        // safe — only the first materialized tree writes it. This is the single
        // source of truth the /onboarding redirect AND the roadmap planning-origin
        // cluster (MOTIR-1013) read. Its return count (1 on the first approve, 0
        // after) IS the onboarding-completion signal the convention trigger fires on.
        const firstOnboarding =
          (await projectRepository.markOnboardingRan(fresh.projectId, new Date(), tx)) === 1;
        const updated = await planRepository.update(
          planId,
          { status: 'approved', decidedAt: new Date(), decidedById: ctx.userId },
          tx,
        );
        // Re-read so the returned items carry the written-back work-item ids.
        const finalItems = await planItemRepository.findByPlan(planId, tx);
        return {
          row: updated,
          items: finalItems,
          firstOnboarding,
          projectKey: project?.identifier ?? null,
        };
      },
    );

    // Fresh-establish the coding convention at onboarding completion (7.3.10 ·
    // MOTIR-839). The FIRST time a project's onboarding plan is approved +
    // materialized, trigger the fresh `propose_convention` job so a `proposed`
    // convention exists for the user to adopt (the 7.14.5/MOTIR-926 surface). The
    // service applies the FRESH gate itself (a repo-backed project's convention is
    // the migrate/audit path's job, MOTIR-931) and reads the pinned stack over the
    // 7.1 boundary. Fired BEST-EFFORT and AFTER the tx commits: the `server-only`
    // client call cannot run inside the DB transaction, and a motir-ai hiccup must
    // never fail an approve that already materialized the tree (the convention can
    // be re-established later; the approve is the durable, user-visible effect).
    // Imported LAZILY (dynamic import) so the `server-only` motir-ai client stays
    // OUT of plansService's static import graph — the E2E plan seeds import
    // plansService in the Playwright Node process, where `server-only` does not
    // resolve; the client loads only when the trigger actually fires on the server.
    if (firstOnboarding && projectKey) {
      await import('@/lib/services/conventionEstablishService')
        .then(({ conventionEstablishService }) =>
          conventionEstablishService.establishForFreshProject({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            projectId: plan.projectId,
            projectKey,
          }),
        )
        .catch((err: unknown) => {
          console.warn(
            `[plansService.approvePlan] fresh-establish convention trigger failed for project ${plan.projectId}; skipping (a proposal can be re-established later)`,
            err,
          );
        });
    }
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
