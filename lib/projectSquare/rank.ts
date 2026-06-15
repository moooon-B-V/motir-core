// The PROJECT SQUARE ranking vocabulary (Story 6.13 · Subtask 6.13.4) — the
// three orderings the cross-org public-project directory (6.13.2) can be sorted
// by, mirroring GitHub Trending + GitLab Explore's tab set:
//
//   • `trending` — RECENT demand: upvotes + project activity inside a recency
//     WINDOW (the GitHub daily/weekly/monthly bucket), so a freshly-surging
//     project rises above a higher-lifetime-but-stale one.
//   • `popular`  — LIFETIME demand: total upvotes (the "most-starred" tab).
//   • `recent`   — newly-made-public: ordered by `madePublicAt` (newest first).
//
// Kept as plain value types + pure parsers so the route (which reads the raw
// `?rank=` / `?window=` query strings) and the service (which validates them)
// share one source of truth. The service throws the typed errors in
// `./errors.ts` when a present-but-unrecognised value fails to parse.

export const PROJECT_SQUARE_RANKS = ['trending', 'popular', 'recent'] as const;
export type ProjectSquareRank = (typeof PROJECT_SQUARE_RANKS)[number];

/**
 * The default rank when `?rank=` is absent — `trending`, matching the mirror
 * products' default landing tab (GitHub Trending and GitLab Explore both open
 * on Trending). The 6.13.6 UI may still default a different tab; this is the
 * service-level default for a rank-less request.
 */
export const DEFAULT_PROJECT_SQUARE_RANK: ProjectSquareRank = 'trending';

export const TRENDING_WINDOWS = ['day', 'week', 'month'] as const;
export type TrendingWindow = (typeof TRENDING_WINDOWS)[number];

/**
 * The default Trending recency window when `?window=` is absent — `week`. The
 * mirror (GitHub Trending) offers day/week/month and defaults to *day*; a small
 * tenant's vote/activity stream is sparse, so a daily window is mostly empty and
 * a weekly one is the meaningful default (a justified rung-1 deviation — the
 * window stays selectable, so a busy tenant can still narrow to `day`).
 */
export const DEFAULT_TRENDING_WINDOW: TrendingWindow = 'week';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The recency window's length in ms — the lookback the Trending rank scores over. */
export function trendingWindowMs(window: TrendingWindow): number {
  switch (window) {
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month':
      return 30 * DAY_MS;
  }
}

/** Parse a raw `?rank=` value; returns null for any unrecognised string. */
export function parseRank(raw: string): ProjectSquareRank | null {
  return (PROJECT_SQUARE_RANKS as readonly string[]).includes(raw)
    ? (raw as ProjectSquareRank)
    : null;
}

/** Parse a raw `?window=` value; returns null for any unrecognised string. */
export function parseTrendingWindow(raw: string): TrendingWindow | null {
  return (TRENDING_WINDOWS as readonly string[]).includes(raw) ? (raw as TrendingWindow) : null;
}
