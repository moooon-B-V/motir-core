import { withWorkspaceContext } from '@/lib/workspaces';
import { planRepository } from '@/lib/repositories/planRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  clampLimit,
  resolveActiveProjectScope,
  windowFor,
  type HomeActorContext,
  type HomeListOptions,
} from '@/lib/services/homeService';
import { planProgressService } from '@/lib/services/planProgressService';
import { toWorkbenchPlanningRowDto } from '@/lib/mappers/workbenchPlanningMappers';
import type { WorkbenchPlanningPageDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';

// THE READER'S PLANS BEING WRITTEN (Story MOTIR-7820 · Subtask MOTIR-7828) — the
// read behind the Workbench's Planning tab: which plans this person asked for are
// still being written in the active project, and how far each one has got.
//
// ⚠️ ONE PREDICATE, TWO READS. Membership lives in `planRepository`'s
// `generatingRequestedByWhere`, which both this page and `homeService.tabCounts`'
// `planning` badge read — the rule the approvals tab states for its own badge. No
// second `status: 'generating'` + `createdById` predicate is written here.
//
// ⚠️ PROGRESS IS REUSED, NOT RE-DERIVED. The page is handed to
// `planProgressService.snapshotsForPlans` and each snapshot is carried through
// unchanged; nothing here reads a step, counts an `add` or compares a clock.

export const workbenchPlanningService = {
  /**
   * One offset window of the reader's own `generating` plans in the active
   * project, newest first, each with its progress. An out-of-range page clamps
   * to the last page, exactly as `homeService`'s tabs do; a reader who may not
   * browse the active project gets an empty page, never an error.
   *
   * A plan that stopped generating between the window read and the snapshot read
   * has no snapshot and is DROPPED from `items` — never rendered with a missing
   * progress. `total` stays the count read with the window, and the next poll
   * re-reads the page.
   *
   * Cost is flat in the page size: one transaction (scope · count + window ·
   * target titles for the one project) plus the snapshot read's fixed batch.
   */
  async listMyPlansBeingWritten(
    ctx: HomeActorContext,
    options: HomeListOptions = {},
  ): Promise<WorkbenchPlanningPageDto> {
    const pageSize = clampLimit(options.limit);
    const { rows, total, page, titles } = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const scope = {
        workspaceId: ctx.workspaceId,
        projectIds: projectScopes.map((s) => s.projectId),
        userId: ctx.userId,
      };
      // COUNT FIRST — the clamp needs the total before the window is read.
      const found = await planRepository.countGeneratingRequestedBy(scope, tx);
      const window = windowFor(found, options.page, pageSize);
      const rows = await planRepository.listGeneratingRequestedBy(
        scope,
        { skip: window.skip, take: pageSize },
        tx,
      );
      // The scope is the ONE active project, so the page's target titles are one
      // read, not one per plan.
      const keys = Array.from(new Set(rows.flatMap((row) => row.session?.targetKeys ?? [])));
      const items = await workItemRepository.findByIdentifiers(ctx.projectId, keys, tx);
      return {
        rows,
        total: found,
        page: window.page,
        titles: new Map(items.map((item) => [item.identifier, item.title])),
      };
    });

    const snapshots = await planProgressService.snapshotsForPlans(rows, ctx);
    const items: WorkbenchPlanningRowDto[] = [];
    for (const row of rows) {
      const progress = snapshots.get(row.id);
      if (!progress) continue;
      items.push(toWorkbenchPlanningRowDto(row, titles, progress));
    }
    return { items, total, page, pageSize };
  },
};
