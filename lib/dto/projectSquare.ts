// DTOs for the PROJECT SQUARE — the SYSTEM-level public-project directory
// (Story 6.13). The square is the cross-org DISCOVERY surface over the projects
// 6.12 made `public`: a fully-public (no sign-in) read that lists EVERY public
// project across EVERY org/workspace and EXCLUDES every non-public one.
//
// These shapes are the load-bearing correctness boundary of Subtask 6.13.2:
// they carry ONLY the card-projection fields — name, the owning org (the
// cross-org context), a description snippet, and the public demand signals —
// so an internal project field can NEVER cross the wire (it is absent from the
// shape, not DOM-hidden). A mapper that forgets to drop an internal field is a
// compile error, not a silent leak (the same structural-projection discipline
// the 6.12.4 public DTOs use).
//
// No Prisma row crosses the boundary, and no `@prisma/client` import is needed.

/**
 * The owning organisation of a public project — the cross-org context every
 * square card shows (a project surfaces under EVERY org, so the card names the
 * org it belongs to). Name + slug only; no internal org field.
 */
export interface ProjectSquareOrgDto {
  name: string;
  /** The org's URL-safe slug (a per-org landing / filter handle). */
  slug: string;
}

/**
 * The public demand signals shown on a square card, read from the 6.12.6
 * signals (Subtask 6.13.2 surfaces them; Subtask 6.13.4 owns the ranking ORDER
 * computed over them).
 *
 * NOTE — the viewer-count gap (flagged for the 6.13 design/rank reconcile):
 * Story 6.13's design (6.13.1) + rank model name a THIRD "viewers" stat, but
 * 6.12.6 shipped NO view-tracking (only the upvote vote model + public-request
 * comments), and 6.13.2 is scoped to add NO new write. So the two REAL signals
 * are surfaced here — total upvotes + a recent-activity timestamp — which also
 * matches the mirror (GitHub Trending / GitLab Explore cards show stars +
 * recency, not a viewer count). A real viewer count would need its own
 * view-tracking write surface (a 6.12 follow-up), out of this card's scope.
 */
export interface ProjectSquareStatsDto {
  /** Total upvotes across the project's public requests (6.12.6). */
  upvotes: number;
  /**
   * The most recent work-item activity in the project, as an ISO-8601 string
   * (the recency signal the Trending rank, 6.13.4, windows over), or null when
   * the project has no non-archived work items yet.
   */
  lastActivityAt: string | null;
}

/**
 * One public project as a square gallery card — the cross-org card projection.
 * Carries ONLY name + org + a description snippet + the public stats; NO
 * internal project field (no workspace id, no access level, no estimation
 * config, …) is present BY DESIGN.
 */
export interface ProjectSquareCardDto {
  /** The project key (e.g. "PROD") — the public URL segment + a card meta. */
  identifier: string;
  /** The project's display name (the card `<h3>`). */
  name: string;
  /** The owning organisation (the cross-org context). */
  org: ProjectSquareOrgDto;
  /**
   * A bounded plain-text snippet of the public Overview/README
   * (`publicOverviewMd`) — the only public-safe description field 6.12.3 added —
   * truncated for the card, or null when the project authored no overview.
   */
  description: string | null;
  stats: ProjectSquareStatsDto;
}

/**
 * A cursor-paginated page of square cards (finding #57 — a system-level list of
 * public projects could be thousands, so the directory is NEVER load-all).
 * `nextCursor` is an opaque keyset cursor for the next page, or null at the end.
 */
export interface ProjectSquarePageDto {
  items: ProjectSquareCardDto[];
  nextCursor: string | null;
}
