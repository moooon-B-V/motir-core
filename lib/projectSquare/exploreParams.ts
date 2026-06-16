import {
  DEFAULT_PROJECT_SQUARE_RANK,
  DEFAULT_TRENDING_WINDOW,
  parseRank,
  parseTrendingWindow,
  type ProjectSquareRank,
  type TrendingWindow,
} from '@/lib/projectSquare/rank';

// exploreParams — the URL-param model for the public PROJECT SQUARE page
// (Story 6.13 · Subtask 6.13.6). The square is fully server-rendered and
// crawlable, so EVERY navigable state (the active rank tab, the Trending window,
// the search query, the topic filter, and the keyset page) is a real URL param —
// no client state. This module is the single place that:
//
//   • normalises raw `?rank=`/`?window=` to a VALID value (junk → the default,
//     so a crawler hitting a malformed URL still gets the default page, never a
//     500), while passing `q`/`category`/`cursor` through as opaque strings; and
//   • builds composable hrefs (`buildExploreHref`) so a tab / filter / "load
//     more" link preserves the OTHER params and resets the cursor when the
//     ordering or result set changes (a stale cursor minted under a different
//     rank/window/search/category is rejected by the service).
//
// The param NAMES match the shipped `/api/public/explore` route (`q` → the
// service `search`, `category` → the service `category`), so the page and the
// API agree. Defaults are OMITTED from a built href (no `?rank=trending`,
// no `?window=week`) so the canonical URL of the default view is a bare
// `/explore` (or `/explore/topic/<slug>`).

/** The normalised, validated square query a page reads from its URL. */
export interface ExploreQuery {
  /** The free-text name/description search (`?q=`), trimmed; empty → undefined. */
  search?: string;
  /** The topic/category filter slug (`?category=`); empty → undefined. */
  category?: string;
  /** The active rank tab — always a valid value (junk normalised to default). */
  rank: ProjectSquareRank;
  /** The Trending recency window — always valid; only meaningful for `trending`. */
  window: TrendingWindow;
  /** The opaque keyset cursor (`?cursor=`) for the requested page, if any. */
  cursor?: string;
}

/** Next.js passes a route's query as this shape (a value may repeat). */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** First value of a (possibly repeated / absent) query param, trimmed non-empty. */
function firstParam(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse a page's raw search params into a normalised {@link ExploreQuery}.
 * `rank` / `window` are coerced to a valid value (unrecognised → the default),
 * so the page never throws on a malformed ordering param; `search` / `category`
 * / `cursor` pass through as trimmed opaque strings. An explicit `category`
 * override (a topic landing page) wins over any `?category=` in the URL.
 */
export function parseExploreSearchParams(
  raw: RawSearchParams,
  overrides?: { category?: string },
): ExploreQuery {
  const rankRaw = firstParam(raw['rank']);
  const windowRaw = firstParam(raw['window']);
  const rank = (rankRaw && parseRank(rankRaw)) || DEFAULT_PROJECT_SQUARE_RANK;
  const window = (windowRaw && parseTrendingWindow(windowRaw)) || DEFAULT_TRENDING_WINDOW;
  return {
    search: firstParam(raw['q']),
    category: overrides?.category ?? firstParam(raw['category']),
    rank,
    window,
    cursor: firstParam(raw['cursor']),
  };
}

/**
 * The selected-but-default-free subset of a query, in the canonical key order.
 * Defaults are dropped (`rank=trending`, `window=week`), `window` is dropped for
 * non-Trending ranks (it has no effect there), and empty search/category are
 * dropped — so two URLs that render the same view serialise identically.
 */
function canonicalEntries(query: ExploreQuery): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (query.search) entries.push(['q', query.search]);
  if (query.category) entries.push(['category', query.category]);
  if (query.rank !== DEFAULT_PROJECT_SQUARE_RANK) entries.push(['rank', query.rank]);
  // The window only applies to Trending; never emit it for popular/recent.
  if (query.rank === 'trending' && query.window !== DEFAULT_TRENDING_WINDOW) {
    entries.push(['window', query.window]);
  }
  if (query.cursor) entries.push(['cursor', query.cursor]);
  return entries;
}

/**
 * Build a composable `/explore` (or topic) href from the CURRENT query plus
 * `overrides`. Any override OTHER than an explicit `cursor` resets pagination
 * (drops the cursor) — switching tab / window / search / topic must restart the
 * keyset from page one (the service rejects a cursor minted under a different
 * ordering/set). To page forward, pass `{ cursor: nextCursor }`. A `category`
 * (or `search`) set to `null` clears that filter.
 */
export function buildExploreHref(
  basePath: string,
  current: ExploreQuery,
  overrides: {
    rank?: ProjectSquareRank;
    window?: TrendingWindow;
    search?: string | null;
    category?: string | null;
    cursor?: string;
  } = {},
): string {
  const changesOrdering =
    overrides.rank !== undefined ||
    overrides.window !== undefined ||
    overrides.search !== undefined ||
    overrides.category !== undefined;

  const next: ExploreQuery = {
    search: overrides.search === null ? undefined : (overrides.search ?? current.search),
    category: overrides.category === null ? undefined : (overrides.category ?? current.category),
    rank: overrides.rank ?? current.rank,
    window: overrides.window ?? current.window,
    // Reset the cursor whenever the ordering/result set changes; otherwise keep
    // only an explicitly-provided one (a "load more" forward step).
    cursor: changesOrdering ? undefined : overrides.cursor,
  };

  const params = new URLSearchParams(canonicalEntries(next));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Whether any narrowing filter (search or topic) is active — drives the
 * no-results vs empty distinction and the "Clear filters" affordance. */
export function hasActiveFilters(query: ExploreQuery): boolean {
  return Boolean(query.search || query.category);
}
