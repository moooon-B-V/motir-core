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
  InvalidProjectSquareCategoryError,
  InvalidProjectSquareCursorError,
  InvalidProjectSquareRankError,
  InvalidProjectSquareWindowError,
} from '@/lib/projectSquare/errors';
import { vocabularyEntry } from '@/lib/projectTags/vocabulary';
import type { ProjectDirectoryRankCursor } from '@/lib/repositories/projectRepository';
import type { ProjectSquarePageDto, ProjectSquareStatsDto } from '@/lib/dto/projectSquare';

/**
 * Max length of a project-square search term (Subtask 6.13.3). A search is a
 * card-directory narrowing, not a document query; a term longer than this is
 * truncated (not rejected) so a pathological query can't build an unbounded
 * ILIKE pattern. 200 chars comfortably covers any real name/description search.
 */
const MAX_SEARCH_LENGTH = 200;

// projectSquareService — the service behind the PROJECT SQUARE, the SYSTEM-level
// cross-org directory of every `public` project (Story 6.13 · Subtasks 6.13.2 +
// 6.13.4 + 6.13.3 search/filter).
//
// This is a thin DISCOVERY index over the 6.12 public-project surface, NOT a new
// access system. It is FULLY PUBLIC: the directory read takes NO `actorUserId`
// and runs NO session/access gate (the page is open to anonymous visitors +
// crawlers — model revision 2026-06-14). The load-bearing correctness lives in
// the repository read, which filters on `accessLevel = 'public'` in ONE place,
// so no non-public project can leak through this or any future caller (the
// 6.13.3 search/tag predicates narrow WITHIN that public filter, never around
// it); and in the `ProjectSquareCardDto` projection, which structurally lacks
// every internal project field. It adds NO new write and NO cross-org grant.
//
// 4-layer: this service validates the rank/window + the search/category
// narrowing, computes the trending recency cutoff, orchestrates the ranked
// directory read + the two stat aggregates, and maps to DTOs; it owns no
// transaction (a pure read path). The route parses the raw `rank` / `window` /
// `cursor` / `q` / `category` params + calls ONE method.

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
   * `search` (the `?q=`) NARROWS the page to a name/description contains-match;
   * `category` (the `?category=`) narrows it to a curated topic tag (an EXISTS
   * over the 6.13.5 tag join). Both COMPOSE with the rank + the cursor under ONE
   * read — they shrink the set, the rank still orders it. An empty/blank search
   * is treated as absent; a `category` outside the curated vocabulary throws
   * InvalidProjectSquareCategoryError (→ 400).
   *
   * Anonymous: no `actorUserId`, no gate. `rank` / `window` are the raw query
   * strings; a present-but-unrecognised value throws InvalidProjectSquareRank /
   * WindowError (→ 400). `cursor` is the opaque keyset token a prior page
   * returned; a malformed one — or one minted under a DIFFERENT
   * rank/window/search/category than requested (switching tabs OR changing the
   * search/filter must restart pagination) — throws
   * InvalidProjectSquareCursorError (→ 400). `nextCursor` is null at the end.
   */
  async listDirectory(
    options: {
      cursor?: string;
      rank?: string;
      window?: string;
      search?: string;
      category?: string;
    } = {},
  ): Promise<ProjectSquarePageDto> {
    const rank = resolveRank(options.rank);
    const window = rank === 'trending' ? resolveWindow(options.window) : null;
    const search = resolveSearch(options.search);
    const category = resolveCategory(options.category);

    // Decode + validate the cursor: it must have been minted under the SAME
    // rank/window AND the SAME search/category we're reading now, else a tab
    // switch or a changed search/filter left a stale cursor pointing into a
    // different ordering/set.
    let repoCursor: ProjectDirectoryRankCursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeRankedCursor(options.cursor);
      if (
        decoded.rank !== rank ||
        decoded.window !== window ||
        decoded.search !== search ||
        decoded.category !== category
      ) {
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
    // shape `publicProjectsService.getWorkItems` uses). The search/category
    // narrowing binds at the repository's base scan; null → undefined (absent).
    const rows = await projectRepository.listPublicDirectoryRanked({
      rank,
      take: DIRECTORY_PAGE_SIZE + 1,
      cursor: repoCursor,
      cutoff,
      search: search ?? undefined,
      categorySlug: category ?? undefined,
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
            search,
            category,
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

/**
 * Normalize the search term: trim it, treat an empty/blank value as ABSENT
 * (null — no narrowing, never an empty `ILIKE '%%'` that matches everything),
 * and cap the length so a pathological query can't build an unbounded pattern.
 * Returned as `string | null` so it pins cleanly into the cursor (null = the
 * unfiltered page).
 */
function resolveSearch(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_SEARCH_LENGTH);
}

/**
 * Resolve the category slug against the curated topic vocabulary: absent → null
 * (no narrowing); a known slug → its canonical form; a present-but-unknown slug
 * → InvalidProjectSquareCategoryError (→ 400). Validating here (not silently
 * returning an empty page) matches the rank/window/cursor strict posture and
 * keeps an off-vocabulary slug from masking a client bug.
 */
function resolveCategory(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const entry = vocabularyEntry(trimmed);
  if (!entry) throw new InvalidProjectSquareCategoryError();
  return entry.slug;
}
