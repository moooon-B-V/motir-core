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
// ⚠️ A FAILED PLAN IS NOT HERE (MOTIR-7914). The failure path leaves a failed hosted plan
// `generating` on purpose, and `generatingRequestedByWhere` carves it out through the data
// card's `FAILED_WAITING_WHERE` — so it neither lists nor counts here, and never turns
// *stalled*; it lives on To resume (`homeService.listToResume`) until the person Resumes it.
//
// ⚠️ PROGRESS IS REUSED, NOT RE-DERIVED. The page is handed to
// `planProgressService.snapshotsForPlans` and each snapshot is carried through
// unchanged; nothing here reads a step, counts an `add` or compares a clock.

/**
 * THE PLANNING TAB'S CEILING — 50 rows, and the tab reads page 1 only
 * (`design/workbench/design-notes.md` § 36.10, MOTIR-7823/7831).
 *
 * ⚠️ IT IS A CEILING, NOT A PAGE SIZE WITH A PAGER. The tab draws **no pager**
 * (§ 28 DECISION 5's form, not § *The pager*'s): a person writes a handful of
 * plans at once, so a pager would be a control that is almost never more than
 * `[1]`. The read stays offset-paged — the window is still `{ page, limit }`, so
 * nothing about the service or the route is special-cased — and what the tab
 * renders is page 1 at this limit, with `total` saying when the ceiling bit. The
 * strip's count stays the TRUE total; the note under the last row is what says
 * why the two differ.
 */
export const PLANNING_TAB_CEILING = 50;

export const workbenchPlanningService = {
  /**
   * One offset window of the reader's own `generating` plans in the active
   * project, newest first, each with its progress. An out-of-range page clamps
   * to the last page, exactly as `homeService`'s tabs do; a reader who may not
   * browse the active project gets an empty page, never an error.
   *
   * The window size defaults to {@link PLANNING_TAB_CEILING}, the one size the
   * tab and its route read (§ 36.10) — a caller may still narrow it, which is
   * what the paging tests do.
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
    const pageSize = clampLimit(options.limit ?? PLANNING_TAB_CEILING);
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
