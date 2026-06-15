import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { toProjectSquareCardDto } from '@/lib/mappers/projectSquareMappers';
import { decodeDirectoryCursor, encodeDirectoryCursor } from '@/lib/projectSquare/cursor';
import type { ProjectSquarePageDto, ProjectSquareStatsDto } from '@/lib/dto/projectSquare';

// projectSquareService — the service behind the PROJECT SQUARE, the SYSTEM-level
// cross-org directory of every `public` project (Story 6.13 · Subtask 6.13.2).
//
// This is a thin DISCOVERY index over the 6.12 public-project surface, NOT a new
// access system. It is FULLY PUBLIC: the directory read takes NO `actorUserId`
// and runs NO session/access gate (the page is open to anonymous visitors +
// crawlers — model revision 2026-06-14). The load-bearing correctness lives in
// the repository read, which filters on `accessLevel = 'public'` in ONE place,
// so no non-public project can leak through this or any future caller; and in
// the `ProjectSquareCardDto` projection, which structurally lacks every internal
// project field. It adds NO new write and NO cross-org grant.
//
// 4-layer: this service orchestrates the directory read + the two stat
// aggregates and maps to DTOs; it owns no transaction (a pure read path). The
// route parses the cursor + calls ONE method.

/**
 * The square gallery page size — a bounded card page (the at-scale rule:
 * finding #57, never load-all a system-level list that could be thousands).
 */
const DIRECTORY_PAGE_SIZE = 24;

export const projectSquareService = {
  /**
   * A cursor-paginated page of public-project cards across EVERY org/workspace,
   * in the directory's deterministic default order (`createdAt` desc, `id`
   * tiebreak — 6.13.4 swaps in the trending/popular/recent rank keys). Resolves
   * each card's public stats (total upvotes + most-recent-activity timestamp)
   * over the page's project ids in TWO grouped aggregates (no per-card N+1).
   *
   * Anonymous: no `actorUserId`, no gate. `cursor` is the opaque keyset token a
   * prior page returned; a malformed one throws InvalidProjectSquareCursorError
   * (→ 400). `nextCursor` is null at the end of the list.
   */
  async listDirectory(options: { cursor?: string } = {}): Promise<ProjectSquarePageDto> {
    const cursor = options.cursor !== undefined ? decodeDirectoryCursor(options.cursor) : undefined;

    // Over-fetch one row to detect a next page, then trim (the same lazy-list
    // shape `publicProjectsService.getWorkItems` uses).
    const rows = await projectRepository.listPublicDirectory({
      take: DIRECTORY_PAGE_SIZE + 1,
      cursor,
    });
    const hasMore = rows.length > DIRECTORY_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DIRECTORY_PAGE_SIZE) : rows;

    const projectIds = page.map((r) => r.id);
    const [upvoteRows, activityRows] = await Promise.all([
      publicRequestVoteRepository.sumUpvotesByProjects(projectIds),
      workItemRepository.maxActivityByProjects(projectIds),
    ]);
    const upvotesByProject = new Map(upvoteRows.map((r) => [r.projectId, r.upvotes]));
    const activityByProject = new Map(activityRows.map((r) => [r.projectId, r.lastActivityAt]));

    const items = page.map((row) => {
      const lastActivity = activityByProject.get(row.id) ?? null;
      const stats: ProjectSquareStatsDto = {
        upvotes: upvotesByProject.get(row.id) ?? 0,
        lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      };
      return toProjectSquareCardDto(row, stats);
    });

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeDirectoryCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return { items, nextCursor };
  },
};
