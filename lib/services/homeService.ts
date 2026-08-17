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
// ⚠️ ACTIVE-PROJECT-SCOPED, like every other list surface (MOTIR-2761). This
// read was workspace-scoped until 2026-08-17 and argued for it from external
// precedent — Jira "Your work", Linear Inbox, Plane Home. In all three that
// surface sits ABOVE the project selector; Motir imported the scope without the
// placement and then put `/home` FIRST in the PROJECT tier of the rail, under a
// project switcher the shell renders on every authed page. A switcher that
// changes nothing on the first screen after sign-in teaches the reader that the
// context path is decoration, so the scope moved to match the placement.
//
// The cross-project question — "what is on me across this whole WORKSPACE" — is
// retained rather than dropped: it becomes a workspace-tier surface, MOTIR-2920
// (`docs/decisions/home-scope.md` §3). It is not this read.

/** The page size a Home tab reads when the caller names none. */
export const HOME_PAGE_SIZE = 25;
/** The ceiling a caller-supplied page size is clamped to. */
const HOME_MAX_PAGE_SIZE = 100;

/**
 * Who is reading, and WHICH PROJECT they are reading. The project id is the
 * caller's ACTIVE project — `getActiveProject()` on the page, the same resolver
 * `/items`, `/ready` and `/boards` use — and it is REQUIRED rather than
 * optional, so there is no call shape that quietly reverts to the workspace.
 */
export interface HomeActorContext extends AccessActorContext {
  projectId: string;
}

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
 * The ACTIVE project — if the actor may browse it — paired with ITS OWN
 * done-category status keys. The two axes Home's reads scope on, now over a set
 * of at most one.
 *
 * ⚠️ THE ACCESS DECISION IS STILL THE SERVICE'S, and narrowing the project axis
 * did not retire it. RLS is WORKSPACE-rooted; the thing Home can leak is a
 * PRIVATE PROJECT INSIDE the actor's own workspace, which RLS admits and
 * `canBrowse` does not — and an actor's ACTIVE project can be one they may not
 * browse (the pointer is a stored member preference, and project membership can
 * be revoked under it). Such a reader gets an EMPTY scope set, so the read is
 * empty rather than an error — the no-existence-leak convention every other
 * project gate follows.
 *
 * ⚠️ AND THE SHAPE STAYS A `HomeProjectScope[]`, not a bare `projectId`. The
 * lifecycle axis MOTIR-2758 added travels inside it precisely so no call shape
 * can scope the projects without also deciding what counts as finished in each
 * of them; collapsing to an id here would be the narrowing quietly dropping it.
 *
 * The result is passed INTO the query, never applied to its output. Filtering
 * after the read would shorten pages instead of failing, and "the list sometimes
 * ends early" is a bug nobody traces back to an access rule.
 */
async function activeProjectScope(
  ctx: HomeActorContext,
  tx: Prisma.TransactionClient,
): Promise<HomeProjectScope[]> {
  const project = await projectRepository.findById(ctx.projectId, tx);
  // The workspace check is belt AND braces: RLS already bounds the read to
  // `ctx.workspaceId`, but a stale active-project pointer is exactly the input
  // that would otherwise cross a tenant on the day RLS is relaxed.
  if (!project || project.workspaceId !== ctx.workspaceId) return [];
  const browsable = await projectAccessService.filterBrowsable([project], ctx, tx);
  if (browsable.length === 0) return [];

  // The LIFECYCLE axis, resolved beside the access one and passed into the query
  // with it (MOTIR-2758). The same resolver `workItemsService.isReady`,
  // `sprintsService` and `planValidityService` already ask "is this terminal, in
  // ITS OWN project" with.
  //
  // ⚠️ Threaded `tx`, not a second context. `workflow_status` is RLS-gated on
  // `app.workspace_id` (`…_add_workflow_status_and_transition_rls`), and that GUC
  // is bound by the `withWorkspaceContext` transaction the caller is already
  // inside. Read on any other connection under the non-bypass `motir_app` role
  // and the answer is NOTHING — an empty done-key set, an exclusion that
  // silently no-ops in production, and a test suite that stays green because it
  // connects as the owner.
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    [ctx.projectId],
    ctx.workspaceId,
    tx,
  );
  return [
    {
      projectId: ctx.projectId,
      /* istanbul ignore next -- defensive: the resolver seeds an entry for every requested project id, so the `?? []` arm is unreachable */
      doneStatusKeys: [...(terminalByProject.get(ctx.projectId) ?? [])],
    },
  ];
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
   * MY WORK — every item in the ACTIVE PROJECT where the actor is the assignee
   * **OR** the reporter, **each item exactly once**, newest-touched first,
   * cursor-paged.
   *
   * The two predicates are merged into one list rather than split into two tabs
   * because Motir is AI-native: an item created through the MCP carries the
   * creating user as REPORTER, and that same user runs it rather than assigning
   * it onward, so reporter and assignee are usually one person wearing two hats.
   * The dedupe requirement exists ONLY because of that merge — and it is the
   * database's job (a single `OR`), not the service's, so it holds across a page
   * boundary and not merely within one page.
   */
  async listMyWork(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
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
   * Resolved together because the project scope — the access check plus that
   * project's done-status keys — is the expensive half and both counts need the
   * same one.
   */
  async tabCounts(ctx: HomeActorContext): Promise<HomeTabCountsDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
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
   * WATCHING — the items the actor watches IN THE ACTIVE PROJECT, same order,
   * same cursor type, same access rule.
   *
   * A genuinely different audience from My work, not a partition of it: an item
   * the actor both owns and watches is returned by BOTH reads. That is not a
   * bug to fix at this layer — the two reads answer different questions, and
   * MOTIR-2655 asserts the overlap explicitly so nobody "corrects" it later.
   */
  async listWatching(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
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
