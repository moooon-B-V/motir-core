// Seed helpers for the CONTEXTUAL (item-anchored) planning acceptance E2E
// (Subtask MOTIR-913 · Story MOTIR-812).
//
// The tenant itself is the shipped `seedAiAugmentReplan` tree — it already has
// exactly the shapes this story needs: a childless story under an epic (the
// PLAN face of the entrance + the expand-into-subtasks case), that story's
// SIBLINGS under the same epic, and the epic itself (the RE-PLAN face, since it
// has children). Re-using it keeps one tenant seeder rather than a second copy.
//
// What this file adds is the ANCHORED proposal seeder: the same
// `createPlan → addProposals → markPlanned` calls a motir-ai plan-edit handler's
// own callbacks make (MOTIR-1746), but with adds parented on an EXISTING work
// item. That is the whole point of contextual planning — the run proposes work
// UNDER the item you opened it on — and the shipped
// `seedPlanChangeProposal` deliberately seeds ROOT adds only (its diff has to
// land on the canvas's top level without drilling).
//
// A `parentRef` holding a REAL work-item id is resolved verbatim by
// `materialize`'s `resolveRef` (only the `planItem:` prefix means an intra-plan
// temp ref), so this is the shipped contract, not a test-only shortcut.

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKind } from '@prisma/client';

/** The stubbed contextual-planning jobs — one per run the spec drives. */
export const CONTEXTUAL_JOB_ID = 'job_e2e_contextual_1';
export const CONTEXTUAL_RETRY_JOB_ID = 'job_e2e_contextual_retry';

/** Resolve a seeded item's database id from the identifier the seed returns.
 *  The proposal substrate keys targets by id; identifiers are the human name. */
export async function workItemIdByKey(projectId: string, identifier: string): Promise<string> {
  const row = await db.workItem.findFirstOrThrow({
    where: { projectId, identifier },
    select: { id: true },
  });
  return row.id;
}

/** One proposed addition. `parentWorkItemId` is an EXISTING item — the anchor the
 *  run proposed this work under (absent = a root-level add). */
export interface ContextualAdd {
  title: string;
  kind: WorkItemKind;
  parentWorkItemId?: string;
  /** Leaf-only (the 2.7.2 ADR): an epic/story carrying a `type` is rejected 422
   *  by the approve, so only pass it for a task/bug/subtask. */
  type?: string;
  storyPoints?: number;
  estimateMinutes?: number;
}

/**
 * Seed the PROPOSALS an item-anchored run would have left behind, as a real
 * `Plan` bound to the stubbed job — so everything on this side of the motir-ai
 * hop runs REAL: the review the rail renders is `planReviewService` reading
 * Postgres, and the confirm is `plansService.approvePlan → materialize`.
 *
 * The plan is left `planned` (the handler's last callback), which is the only
 * status the rail treats as a pending review.
 */
export async function seedContextualProposal(
  ctx: ServiceContext,
  projectId: string,
  args: {
    jobId: string;
    title: string;
    adds?: readonly ContextualAdd[];
    /** A `modify` of an existing item — the re-plan-the-parent case. */
    modify?: { workItemId: string; patch: Record<string, unknown> };
  },
): Promise<string> {
  const plan = await plansService.createPlan(
    projectId,
    { title: args.title, sourceJobId: args.jobId },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    [
      ...(args.adds ?? []).map((add) => ({
        op: 'add' as const,
        ...(add.parentWorkItemId ? { parentRef: add.parentWorkItemId } : {}),
        proposedFields: {
          title: add.title,
          kind: add.kind,
          ...(add.type ? { type: add.type } : {}),
          ...(add.storyPoints !== undefined ? { storyPoints: add.storyPoints } : {}),
          ...(add.estimateMinutes !== undefined ? { estimateMinutes: add.estimateMinutes } : {}),
        },
      })),
      ...(args.modify
        ? [{ op: 'modify' as const, workItemId: args.modify.workItemId, patch: args.modify.patch }]
        : []),
    ],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

/** The anchor's direct children, by title — the "did it land UNDER the item?"
 *  read. Ordered so an assertion can compare a stable list. */
export async function childTitlesOf(parentId: string): Promise<string[]> {
  const rows = await db.workItem.findMany({
    where: { parentId },
    orderBy: { title: 'asc' },
    select: { title: true },
  });
  return rows.map((r) => r.title);
}
