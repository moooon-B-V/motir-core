// =================================================================
// The plan CONTENT trail (Story MOTIR-3532 · Subtask MOTIR-3535). Every
// `plansService` mutation — the open, an append, an edit, the close, and both
// decisions — calls `recordRevision` to persist ONE append-only row describing
// what it did, INSIDE the same transaction as the mutation itself.
//
// ⚠️ THE REQUIRED `tx` IS THE WHOLE GUARANTEE. A revision written AFTER the
// commit can be lost while the mutation stands; one written in its OWN
// transaction can commit while the mutation rolls back. Both produce a trail
// that LIES, in opposite directions, and a trail that can lie is worse than no
// trail — it is read as evidence. So the parameter is non-optional and the
// service owns no transaction of its own: it threads the caller's `tx` straight
// into the repository write.
//
// ⚠️ AND THIS IS NOT A SIDE EFFECT — the side-effects-outside-the-transaction
// rule in `CLAUDE.md` does NOT apply to it, however much the neighbouring code
// reads as though it must. That rule governs external I/O — email, webhooks,
// blob operations, event emits — whose failure must not roll back a durable
// write. This is a database write ABOUT a database write, in the same database,
// and its atomicity with the mutation is the entire point of the card. Nothing
// here is best-effort and nothing here is swallowed.
//
// Layer rules (CLAUDE.md): no transaction, no DTO mapping (the read path and its
// DTO are the sibling card's), no reads. `workItemRevisionsService` is the
// shipped precedent this mirrors exactly.

import type { Prisma, WorkItemPlanningSource } from '@/generated/prisma/client';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';

/**
 * The audit verb for a plan revision — one per mutation site, and the reader's
 * whole vocabulary for what happened to a plan's contents.
 *
 * The column is plain text rather than an enum (the `WorkItemRevision.changeKind`
 * call, made for the same reason), so a seventh verb is a code change rather than
 * a migration. `withdrawn` is that seventh verb, added by MOTIR-3540 exactly as
 * this comment anticipated — a proposal taken OFF a plan.
 *
 * ⚠️ A STRUCTURAL CORRECTION stays `edited` rather than gaining a verb of its
 * own: it changes a proposal that is still on the plan, which is what `edited`
 * already means, and its `diff` carries `correction: true` plus the fields it
 * touched for a reader who needs to tell the two apart. A withdraw is a
 * different verb because the proposal STOPS EXISTING, which no `edited` row can
 * say. And it is `withdrawn`, not `removed`: a `remove` OP is a proposal to
 * delete an existing work item from the tree, so rendering a withdraw as
 * *"1 proposal removed"* would read to a reviewer as a card being deleted.
 */
export type PlanRevisionChangeKind =
  | 'created'
  | 'appended'
  | 'edited'
  | 'withdrawn'
  | 'planned'
  | 'approved'
  | 'declined';

/**
 * WHICH AGENT performed a change, when one did — the
 * `source · harness · model` triple `docs/decisions/work-item-provenance.md`
 * Decision 2 fixes, recorded PER ACT.
 *
 * Deliberately not read off the `Plan` row at render time: the plan's
 * `authorSource` says who WROTE the plan, and that stops being the answer the
 * moment a person edits or decides an agent-written one. A row that carries its
 * own actor cannot disagree with itself later.
 */
export interface PlanRevisionAgentActor {
  source: WorkItemPlanningSource | null;
  harness: string | null;
  model: string | null;
}

/**
 * The arguments a plan mutation passes when recording its revision.
 *
 * `changedById` is NULLABLE and the null is a MEANING — the same one
 * `Plan.createdById` documents for itself. `autoPlanCadenceService` runs the
 * watcher under the PROJECT OWNER's credential so the job has one; recording that
 * owner would attribute to a person an act they never performed. So a
 * generation-time write on a `cadence` plan passes null, while the review edit
 * and both decisions always pass their actor, because only a person reaches them.
 *
 * `diff` is intentionally loose (`Record<string, unknown>`): it carries a
 * COUNT-shaped payload whose shape varies per kind — how many proposals an append
 * carried, which fields an edit supplied, how many items a decision covered —
 * never the proposal bodies themselves.
 */
export interface RecordPlanRevisionArgs {
  planId: string;
  planItemId?: string | null;
  changedById: string | null;
  changeKind: PlanRevisionChangeKind;
  actor?: PlanRevisionAgentActor | null;
  diff: Record<string, unknown>;
}

export const planRevisionsService = {
  /**
   * Record one revision row for a plan mutation, inside the caller's transaction
   * (required `tx`). Returns the created row's id; every current call site is
   * free to ignore it.
   */
  async recordRevision(
    args: RecordPlanRevisionArgs,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const row = await planRevisionRepository.create(
      {
        planId: args.planId,
        planItemId: args.planItemId ?? null,
        changedById: args.changedById,
        changeKind: args.changeKind,
        actorSource: args.actor?.source ?? null,
        actorHarness: args.actor?.harness ?? null,
        actorModel: args.actor?.model ?? null,
        diff: args.diff as Prisma.InputJsonValue,
      },
      tx,
    );
    return row.id;
  },
};
