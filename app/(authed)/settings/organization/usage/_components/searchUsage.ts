import type { OrgUsageDTO, SearchRunDTO } from '@/lib/dto/aiUsage';

// Pure view-model math for SEARCH SPEND on the usage dashboard (Story MOTIR-4334
// · MOTIR-4558; `design/ai-usage/design-notes.md` "Amendment 2026-09-05"). Kept
// in a non-'use client' module — the `ciFigures.ts` precedent one area over — so
// every drawn state is provable without mounting the page.
//
// It DERIVES only presentation. Every quantity comes verbatim from
// `OrgUsageDTO.search` / `.searchRuns`, which `aiUsageService` carries across the
// 7.1 boundary from motir-ai. Nothing here recomputes a number, and in particular
// **the remainder is NOT re-derived** — `unattributedSpend` arrives already
// computed over the same population as the total, so re-deriving it here from a
// page of rows would let the two sides of the boundary disagree about a figure
// the customer reconciles by eye.

/**
 * How a figure responds to the drill control — the decision this asset exists to
 * make, and the reason the tag is not decoration.
 *
 * `search.totalSpend` is ORG-LEVEL: a search made outside any run has no project
 * to attribute to, so the organization total is the only honest place to count
 * them all, and it does NOT narrow when the scope moves. `attributedSpend` DOES
 * narrow, because an attributed search has a run and a run has a project.
 *
 * Both are true and both are useful; what is not acceptable is being unable to
 * tell which is which, because **a number that silently ignores the scope
 * selector above it is the surface lying quietly.**
 */
export type FigureScope = 'follows-scope' | 'organization';

export type SearchUsageVariant =
  /** Something was spent on search in this scope's period. */
  | 'spend'
  /**
   * No search spend. Deliberately NOT the dashboard's global empty state, which
   * fires only when there is no usage AT ALL — token spend beside this may be
   * non-zero, in which case the page is emphatically not empty.
   */
  | 'none'
  /**
   * The boundary reported no `search` block — a rolling deploy where the
   * motir-ai half has not landed. **UNAVAILABLE, never zero.**
   */
  | 'unavailable';

export interface SearchUsageFigures {
  variant: SearchUsageVariant;
  /** Org-level, scope-INDEPENDENT. `null` when unavailable. */
  monthSpend: number | null;
  /** Org-level, scope-independent, all time. `null` when unavailable. */
  totalSpend: number | null;
  /** Follows the drill scope. `null` when unavailable. */
  attributedSpend: number | null;
  /**
   * Org-level. The searches that debited outside any run — `MOTIR-2778` §4 makes
   * two such arrivals legitimate — so this is a real, explainable quantity and
   * NOT a reconciliation failure. `null` when unavailable.
   */
  unattributedSpend: number | null;
  /** True when there IS a remainder to explain. At zero the surface draws
   *  nothing rather than a line reading "not attributed — 0", which would invite
   *  the reader to look for a problem that does not exist. */
  hasRemainder: boolean;
  figuresUnavailable: boolean;
}

/**
 * The search figures for the dashboard, or `null` when there is NO figure to
 * render.
 *
 * ⚠️ THE `isMeta` ARM IS GONE (Story MOTIR-4337 · MOTIR-4572). It returned
 * `null` because the dashboard showed the meta org an "Unlimited" word instead
 * of a balance, so a search figure beside it would have been the only number on
 * a page that claimed none applied. That treatment is deleted: every org now
 * renders the real figures, and search spend is one of them — the run log, the
 * per-model breakdown and this block are exactly what the story exists to make
 * visible to the org that produces most of them.
 */
export function searchUsageFigures(data: OrgUsageDTO): SearchUsageFigures | null {
  // ⚠️ Checked FIRST so it can never fall through into the zero branch. The two
  // are one `if` apart and opposite in meaning.
  //
  // `== null` catches UNDEFINED as well as null, and that is deliberate rather
  // than loose: the DTO types these `T | null`, but the value arrives as JSON
  // over the 7.1 boundary, where an omitted key is `undefined` and a reported
  // absence is `null`. Both mean the same thing here — the block was not
  // reported — and only one of them is expressible in the type.
  if (data.search == null || data.searchRuns == null) {
    return {
      variant: 'unavailable',
      monthSpend: null,
      totalSpend: null,
      attributedSpend: null,
      unattributedSpend: null,
      hasRemainder: false,
      figuresUnavailable: true,
    };
  }

  const { totalSpend, monthSpend } = data.search;
  const { attributedSpend, unattributedSpend } = data.searchRuns;

  return {
    variant: monthSpend === 0 && totalSpend === 0 ? 'none' : 'spend',
    monthSpend,
    totalSpend,
    attributedSpend,
    unattributedSpend,
    hasRemainder: unattributedSpend > 0,
    figuresUnavailable: false,
  };
}

/** One row of the activity log, discriminated so the table renders each kind in
 *  its own columns without a second list or a second pager. */
export type ActivityEntry =
  | { kind: 'run'; at: string; run: OrgUsageDTO['recentRuns']['runs'][number] }
  | { kind: 'search'; at: string; search: SearchRunDTO };

/**
 * ONE list, not two. The page answers *where did my credits go*, and splitting
 * search into its own table would put the reconciliation back on the reader.
 *
 * ⚠️ The two SOURCES are different populations, paged independently: a run
 * appears in `searchRuns.runs` once it has spent on search — including a
 * search-only run, which `recentRuns` omits because it has no model. So this
 * merges **this page of each**, newest first; it does not join them, and it does
 * not fetch more. The list stays page-at-a-time exactly as it was.
 */
export function activityEntries(data: OrgUsageDTO): ActivityEntry[] {
  const runs: ActivityEntry[] = data.recentRuns.runs.map((run) => ({
    kind: 'run',
    at: run.startedAt,
    run,
  }));
  const searches: ActivityEntry[] = (data.searchRuns?.runs ?? []).map((search) => ({
    kind: 'search',
    at: search.lastSearchAt,
    search,
  }));
  return [...runs, ...searches].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * How many pages the pager must offer.
 *
 * The shipped pager sized itself on `recentRuns` alone. With a second paged list
 * in the same table that would make any search page beyond the run count
 * UNREACHABLE — so it takes the larger of the two. This adds pages; it never
 * turns a paged read into a load-all.
 */
export function activityPageCount(data: OrgUsageDTO): number {
  const runPages = Math.ceil(data.recentRuns.total / Math.max(1, data.recentRuns.pageSize));
  const searchPages = data.searchRuns
    ? Math.ceil(data.searchRuns.total / Math.max(1, data.searchRuns.pageSize))
    : 0;
  return Math.max(1, runPages, searchPages);
}
