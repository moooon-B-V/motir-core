import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { toProjectSquareCardDto } from '@/lib/mappers/projectSquareMappers';
import { decodeRankedCursor, encodeRankedCursor } from '@/lib/projectSquare/rankCursor';
import {
  DEFAULT_PROJECT_SQUARE_RANK,
  DEFAULT_TRENDING_WINDOW,
  parseRank,
  parseTrendingWindow,
  trendingWindowMs,
  type ProjectSquareRank,
  type TrendingWindow,
} from '@/lib/projectSquare/rank';
import {
  InvalidProjectSquareCursorError,
  InvalidProjectSquareRankError,
  InvalidProjectSquareWindowError,
} from '@/lib/projectSquare/errors';
import type { ProjectDirectoryRankCursor } from '@/lib/repositories/projectRepository';
import type { ProjectSquarePageDto, ProjectSquareStatsDto } from '@/lib/dto/projectSquare';

// projectSquareService — the service behind the PROJECT SQUARE, the SYSTEM-level
// cross-org directory of every `public` project (Story 6.13 · Subtasks 6.13.2 +
// 6.13.4).
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
// 4-layer: this service validates the rank/window, computes the trending recency
// cutoff, orchestrates the ranked directory read + the two stat aggregates, and
// maps to DTOs; it owns no transaction (a pure read path). The route parses the
// raw `rank` / `window` / `cursor` params + calls ONE method.

/**
 * The square gallery page size — a bounded card page (the at-scale rule:
 * finding #57, never load-all a system-level list that could be thousands).
 */
const DIRECTORY_PAGE_SIZE = 24;

export const projectSquareService = {
  /**
   * A cursor-paginated, RANKED page of public-project cards across EVERY
   * org/workspace (Subtask 6.13.4). `rank` (`trending` | `popular` | `recent`,
   * default `trending`) selects the ordering — each a DETERMINISTIC total order
   * over the 6.12.6 vote/activity signals, riding a keyset cursor so the tab is
   * paginatable, never load-all. `window` (`day` | `week` | `month`, default
   * `week`) is the Trending recency window; ignored by the other ranks. Each
   * card also carries the displayed lifetime stats (total upvotes +
   * most-recent-activity timestamp), resolved over the page's project ids in TWO
   * grouped aggregates (no per-card N+1) — these are the SAME displayed stats for
   * every rank; only the ORDER changes.
   *
   * Anonymous: no `actorUserId`, no gate. `rank` / `window` are the raw query
   * strings; a present-but-unrecognised value throws InvalidProjectSquareRank /
   * WindowError (→ 400). `cursor` is the opaque keyset token a prior page
   * returned; a malformed one — or one minted under a DIFFERENT rank/window than
   * requested (switching tabs must restart pagination) — throws
   * InvalidProjectSquareCursorError (→ 400). `nextCursor` is null at the end.
   */
  async listDirectory(
    options: { cursor?: string; rank?: string; window?: string } = {},
  ): Promise<ProjectSquarePageDto> {
    const rank = resolveRank(options.rank);
    const window = rank === 'trending' ? resolveWindow(options.window) : null;

    // Decode + validate the cursor: it must have been minted under the SAME
    // rank/window we're reading now, else a tab switch left a stale cursor.
    let repoCursor: ProjectDirectoryRankCursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeRankedCursor(options.cursor);
      if (decoded.rank !== rank || decoded.window !== window) {
        throw new InvalidProjectSquareCursorError();
      }
      repoCursor =
        decoded.ts !== null
          ? { ts: new Date(decoded.ts), id: decoded.id }
          : { score: decoded.score as number, id: decoded.id };
    }

    // Trending scores over a recency window whose cutoff is a bound JS Date
    // (`now - windowMs`) — NEVER SQL NOW() (the timestamp-TZ-skew rule).
    const cutoff = window ? new Date(Date.now() - trendingWindowMs(window)) : undefined;

    // Over-fetch one row to detect a next page, then trim (the same lazy-list
    // shape `publicProjectsService.getWorkItems` uses).
    const rows = await projectRepository.listPublicDirectoryRanked({
      rank,
      take: DIRECTORY_PAGE_SIZE + 1,
      cursor: repoCursor,
      cutoff,
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
      hasMore && last
        ? encodeRankedCursor({
            rank,
            window,
            score: last.sortScore,
            ts: last.sortTs ? last.sortTs.toISOString() : null,
            id: last.id,
          })
        : null;

    return { items, nextCursor };
  },
};

/** Resolve the requested rank: absent → default; present-but-invalid → throw. */
function resolveRank(raw: string | undefined): ProjectSquareRank {
  if (raw === undefined) return DEFAULT_PROJECT_SQUARE_RANK;
  const rank = parseRank(raw);
  if (!rank) throw new InvalidProjectSquareRankError();
  return rank;
}

/** Resolve the trending window: absent → default; present-but-invalid → throw. */
function resolveWindow(raw: string | undefined): TrendingWindow {
  if (raw === undefined) return DEFAULT_TRENDING_WINDOW;
  const window = parseTrendingWindow(raw);
  if (!window) throw new InvalidProjectSquareWindowError();
  return window;
}
