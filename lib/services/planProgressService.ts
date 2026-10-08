// Plan PROGRESS — the server half of the one progress derivation (Story
// MOTIR-7820 · Subtask MOTIR-7825). It gathers the rows the pure snapshot
// builder (`lib/plans/planProgress.ts`) needs and hands them over; it decides
// nothing itself — the phrase, the authored test, the drop rules and the clock
// all live in that module, so the plan surface and the Workbench tab cannot
// disagree.
//
// Two doors, one builder:
//   - `snapshotsForPlans` — a PAGE of plans (the reader's plans-being-written
//     read). FOUR batched reads, never one per plan.
//   - `snapshotForReview` — the plan review read (`GET /api/plans/[id]`, polled
//     every 2.5 s while generating), built from the rows that read already holds;
//     it adds at most a titles read for committed step targets it does not name,
//     and the project's explanations setting for a non-MCP plan.

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanItemDto, PlanStepDto } from '@/lib/dto/plans';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { toPlanStepDto } from '@/lib/mappers/planMappers';
import { isTempRef } from '@/lib/plans/refs';
import {
  buildPlanProgressSnapshot,
  progressRowOfAdd,
  requireExplanationFor,
  type PlanProgressAddRow,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';

/** What the progress read needs to know about a plan — any plan DTO or row
 *  carrying these fields will do. */
export interface PlanProgressPlanInput {
  id: string;
  projectId: string;
  status: string;
  createdAt: string | Date;
  lastActivityAt: string | Date;
  authorSource: string | null;
}

/** The committed (non-`planItem:`) targets the steps name. */
function committedTargetIds(steps: readonly { targetRef: string | null }[]): string[] {
  return Array.from(
    new Set(
      steps.map((s) => s.targetRef).filter((ref): ref is string => ref !== null && !isTempRef(ref)),
    ),
  );
}

export const planProgressService = {
  /**
   * One snapshot per `generating` plan in `plans` (none for any other status),
   * keyed by plan id. Four batched reads in one bound transaction — the steps,
   * the `add` flags, the committed step targets' titles, and the projects'
   * `aiGenerateExplanations` — so the cost is the same for 1 plan and for 10.
   */
  async snapshotsForPlans(
    plans: readonly PlanProgressPlanInput[],
    ctx: ServiceContext,
  ): Promise<Map<string, PlanProgressSnapshot>> {
    const generating = plans.filter((p) => p.status === 'generating');
    const out = new Map<string, PlanProgressSnapshot>();
    if (generating.length === 0) return out;
    const planIds = generating.map((p) => p.id);
    const projectIds = Array.from(new Set(generating.map((p) => p.projectId)));

    const { steps, rows, titles, explanationsByProject } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => {
        // Bound: `plan_step`'s policy joins to `plan`, so an unbound read is an
        // empty set that would read as "nobody is working on it".
        const steps = await planStepRepository.listByPlanIds(planIds, tx);
        const rows = await planItemRepository.findProgressRowsByPlanIds(planIds, tx);
        const titles = await workItemRepository.findTitlesByIds(
          committedTargetIds(steps),
          ctx.workspaceId,
          tx,
        );
        const projects = await projectRepository.findManyByIds(projectIds, tx);
        return {
          steps,
          rows,
          titles,
          explanationsByProject: new Map(projects.map((p) => [p.id, p.aiGenerateExplanations])),
        };
      },
    );
    // The server instant the snapshots were built at — `serverNow`'s anchor.
    const observedAt = new Date();
    const committedTitles = new Map(titles.map((t) => [t.id, t.title]));

    const stepsByPlan = new Map<string, PlanStepDto[]>();
    for (const step of steps) {
      const list = stepsByPlan.get(step.planId) ?? [];
      list.push(toPlanStepDto(step));
      stepsByPlan.set(step.planId, list);
    }
    const rowsByPlan = new Map<string, PlanProgressAddRow[]>();
    for (const { planId, ...row } of rows) {
      const list = rowsByPlan.get(planId) ?? [];
      list.push(row);
      rowsByPlan.set(planId, list);
    }

    for (const plan of generating) {
      out.set(
        plan.id,
        buildPlanProgressSnapshot({
          plan,
          steps: stepsByPlan.get(plan.id) ?? [],
          addRows: rowsByPlan.get(plan.id) ?? [],
          committedTitles,
          requireExplanation: requireExplanationFor({
            authorSource: plan.authorSource,
            projectAiGenerateExplanations: explanationsByProject.get(plan.projectId) ?? false,
          }),
          observedAt,
        }),
      );
    }
    return out;
  },

  /**
   * The review read's snapshot, built from the plan items and steps it already
   * loaded. `null` unless the plan is `generating`. `knownTitles` are committed
   * work-item titles the review read already holds (its target/ancestor rows);
   * only a committed step target missing from them is read.
   */
  async snapshotForReview(
    plan: PlanProgressPlanInput,
    items: readonly PlanItemDto[],
    steps: readonly PlanStepDto[],
    ctx: ServiceContext,
    knownTitles: ReadonlyMap<string, string> = new Map(),
  ): Promise<PlanProgressSnapshot | null> {
    if (plan.status !== 'generating') return null;
    const missing = committedTargetIds(steps).filter((id) => !knownTitles.has(id));
    const needsSetting = plan.authorSource !== 'mcp';
    const { extraTitles, aiGenerateExplanations } =
      missing.length === 0 && !needsSetting
        ? { extraTitles: [], aiGenerateExplanations: false }
        : await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
            const extraTitles = await workItemRepository.findTitlesByIds(
              missing,
              ctx.workspaceId,
              tx,
            );
            const settings = needsSetting
              ? await projectRepository.findAiSettings(plan.projectId, tx)
              : null;
            return {
              extraTitles,
              aiGenerateExplanations: settings?.aiGenerateExplanations ?? false,
            };
          });
    const committedTitles = new Map(knownTitles);
    for (const t of extraTitles) committedTitles.set(t.id, t.title);
    return buildPlanProgressSnapshot({
      plan,
      steps,
      addRows: items
        .filter((i) => i.op === 'add')
        .map((i) =>
          progressRowOfAdd({
            id: i.id,
            workItemId: i.workItemId,
            parentRef: i.parentRef,
            proposedFields: i.proposedFields as Record<string, unknown> | null,
          }),
        ),
      committedTitles,
      requireExplanation: requireExplanationFor({
        authorSource: plan.authorSource,
        projectAiGenerateExplanations: aiGenerateExplanations,
      }),
      observedAt: new Date(),
    });
  },
};
