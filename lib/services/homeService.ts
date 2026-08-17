import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  workItemRepository,
  type HomeProjectScope,
  type HomeWorkItemRow,
} from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { toHomeWorkItemRowDto } from '@/lib/mappers/homeMappers';
import { decodeHomeCursor, encodeHomeCursor } from '@/lib/home/cursor';
import type { HomePageDto, HomeTabCountsDto } from '@/lib/dto/home';

// The Home landing surface's read layer (Story MOTIR-2649 · Subtask
// MOTIR-2651) — the business logic behind `/home`'s two tabs. Orchestrates the
// repositories, owns the ACCESS decision, and maps to DTOs; the repositories
// stay leaves (CLAUDE.md § the 4-layer architecture).
//
// ⚠️ WORKSPACE-SCOPED, AND THAT IS THE POINT. Every other list surface in the
// product (`/items`, `/ready`, `/boards`) resolves an ACTIVE PROJECT first.
// Home does not, and takes no `projectId`: "related to me" stops meaning much
// if it hides the projects you are not currently switched into. Switching the
// active project does not change what these reads return. The precedent for the
// shape is `notificationsService.listNotifications`, already `ctx.userId`-scoped
// inside a workspace.

/** The page size a Home tab reads when the caller names none. */
export const HOME_PAGE_SIZE = 25;
/** The ceiling a caller-supplied page size is clamped to. */
const HOME_MAX_PAGE_SIZE = 100;

export interface HomeListOptions {
  /** The opaque token from a previous page's `nextCursor`; omit for page one. */
  cursor?: string | null;
  limit?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return HOME_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) return HOME_PAGE_SIZE;
  return Math.min(Math.floor(limit), HOME_MAX_PAGE_SIZE);
}

/**
 * The projects the actor may BROWSE in this workspace, each paired with ITS OWN
 * done-category status keys — the two axes Home's reads scope on.
 *
 * ⚠️ This is the load-bearing line of the whole card, and it is resolved through
 * the shipped `projectAccessService` rather than left to RLS. RLS is
 * WORKSPACE-rooted; the thing Home can leak is a PRIVATE PROJECT INSIDE the
 * actor's own workspace, which RLS admits and `canBrowse` does not. A workspace
 * owner/admin keeps every project; a non-member of the workspace resolves to
 * NONE, so a stranger's read is empty rather than an error — the no-existence-
 * leak convention every other project gate follows.
 *
 * The result is passed INTO the query as `projectScopes`, never applied to its
 * output. Filtering after the read would shorten pages instead of failing, and
 * "the list sometimes ends early" is a bug nobody traces back to an access rule.
 * The lifecycle half rides the same rule, for the same reason.
 */
async function browsableProjectScopes(
  ctx: AccessActorContext,
  tx: Prisma.TransactionClient,
): Promise<HomeProjectScope[]> {
  const projects = await projectRepository.findByWorkspace(ctx.workspaceId, tx);
  const browsable = await projectAccessService.filterBrowsable(projects, ctx, tx);
  const projectIds = browsable.map((project) => project.id);
  // The LIFECYCLE axis, resolved beside the access one and passed into the query
  // with it (MOTIR-2758). One batched read for every project — the same resolver
  // `workItemsService.isReady`, `sprintsService` and `planValidityService`
  // already ask "is this terminal, in ITS OWN project" with.
  //
  // ⚠️ Threaded `tx`, not a second context. `workflow_status` is RLS-gated on
  // `app.workspace_id` (`…_add_workflow_status_and_transition_rls`), and that GUC
  // is bound by the `withWorkspaceContext` transaction the caller is already
  // inside. Read on any other connection under the non-bypass `motir_app` role
  // and the answer is NOTHING — an empty done-key set, an exclusion that
  // silently no-ops in production, and a test suite that stays green because it
  // connects as the owner.
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    projectIds,
    ctx.workspaceId,
    tx,
  );
  return projectIds.map((projectId) => ({
    projectId,
    /* istanbul ignore next -- defensive: the resolver seeds an entry for every requested project id, so the `?? []` arm is unreachable */
    doneStatusKeys: [...(terminalByProject.get(projectId) ?? [])],
  }));
}

/**
 * Shape one repository page into the wire DTO.
 *
 * The reads are asked for `limit + 1` rows: the extra row is the HAS-MORE
 * probe, dropped before mapping. A `nextCursor` minted from a row that is not
 * returned is what makes the boundary exact — the alternative (mint a cursor
 * whenever the page came back full) hands the caller a cursor to an empty page
 * on every list whose length is a multiple of the page size.
 */
function toPage(rows: HomeWorkItemRow[], limit: number, viewerId: string): HomePageDto {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((row) => toHomeWorkItemRowDto(row, viewerId)),
    nextCursor:
      hasMore && last ? encodeHomeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
  };
}

export const homeService = {
  /**
   * MY WORK — every item in the workspace where the actor is the assignee **OR**
   * the reporter, across every project they may browse, **each item exactly
   * once**, newest-touched first, cursor-paged.
   *
   * The two predicates are merged into one list rather than split into two tabs
   * because Motir is AI-native: an item created through the MCP carries the
   * creating user as REPORTER, and that same user runs it rather than assigning
   * it onward, so reporter and assignee are usually one person wearing two hats.
   * The dedupe requirement exists ONLY because of that merge — and it is the
   * database's job (a single `OR`), not the service's, so it holds across a page
   * boundary and not merely within one page.
   */
  async listMyWork(ctx: AccessActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await browsableProjectScopes(ctx, tx);
      return workItemRepository.findByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        { projectScopes, take: limit + 1, cursor },
        tx,
      );
    });
    return toPage(rows, limit, ctx.userId);
  },

  /**
   * BOTH tab counts, in one workspace context.
   *
   * The tab strip shows the size of the tab you are NOT looking at as well as
   * the one you are, so a reader can tell whether switching is worth it — which
   * means the numbers are the size of each SET, not of the current page.
   * Resolved together because the browsable-project set is the expensive half
   * and both counts need the same one.
   */
  async tabCounts(ctx: AccessActorContext): Promise<HomeTabCountsDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await browsableProjectScopes(ctx, tx);
      const [myWork, watching] = await Promise.all([
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          tx,
        ),
        watcherRepository.countByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
      ]);
      return { myWork, watching };
    });
  },

  /**
   * WATCHING — the items the actor watches in this workspace, same order, same
   * cursor type, same access rule.
   *
   * A genuinely different audience from My work, not a partition of it: an item
   * the actor both owns and watches is returned by BOTH reads. That is not a
   * bug to fix at this layer — the two reads answer different questions, and
   * MOTIR-2655 asserts the overlap explicitly so nobody "corrects" it later.
   */
  async listWatching(ctx: AccessActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await browsableProjectScopes(ctx, tx);
      return watcherRepository.listByUser(
        ctx.userId,
        ctx.workspaceId,
        { projectScopes, take: limit + 1, cursor },
        tx,
      );
    });
    return toPage(rows, limit, ctx.userId);
  },
};
