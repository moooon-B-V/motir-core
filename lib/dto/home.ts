import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';

// Wire DTOs for the Home domain (Story MOTIR-2649 · Subtask MOTIR-2651) — the
// signed-in landing surface's two personal reads. `homeService` maps Prisma rows
// to these via `lib/mappers/homeMappers.ts` just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching the
// work-items / notifications DTO convention.
//
// ⚠️ This is a SEPARATE row shape from `WorkItemListItemDto`, deliberately, and
// the reason is worth stating once. Home's row is not the `/items` row: it ADDS
// the owning project (a project-scoped list never needs to say which project it
// is in) and the reader's own relation to the item, and it DROPS `hasDescription`
// and `dueDate` — the first because it exists to drive the `/items` row ⋯ menu,
// which `design/home/` does not draw, and the second because Home's column set
// has no Due cell. Widening the shared DTO instead would have put two fields on
// every tree/list/archived row in the product to serve one surface.

/** The owning project, as Home's row identifies it (the design's Project cell). */
export interface HomeProjectRefDto {
  id: string;
  /** The `MOTIR` / `ATLAS` project key — the prefix the item's identifier carries. */
  identifier: string;
  name: string;
}

/**
 * One row of My work or Watching.
 *
 * **`viewerIsAssignee` / `viewerIsReporter` are BOTH carried, and both can be
 * true.** That is the whole point of the merged read: an item where the reader
 * is assignee AND reporter comes back exactly ONCE, and these two booleans are
 * how the row still says both things about it. A renderer derives the design's
 * "Your role" cell from the pair (`Assigned` · `Reported` · `Both`); the service
 * does not pre-compute a label, so the copy stays a UI decision.
 *
 * On the WATCHING read both flags are still resolved against the same reader —
 * an item the reader watches but does not own carries `false`/`false`, and one
 * they watch AND own carries the same pair My work would give it. Watching is a
 * different audience, not a partition of My work.
 */
export interface HomeWorkItemRowDto {
  id: string;
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (`code` / `design` / …); `null` on containers. */
  type: WorkItemTypeDto | null;
  key: number;
  identifier: string;
  title: string;
  /** The raw workflow status KEY (not the label) — the caller resolves display. */
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  /**
   * WHO executes it — `coding_agent` | `human` | null. Carried so the row can
   * render the agent treatment `design/home/` specifies (a badge on the
   * assignee avatar). An agent-executed item is returned by these reads like
   * any other; it is never filtered out and never sectioned off.
   */
  executor: ExecutorDto | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** ISO-8601 last-modified stamp — the page cursor's axis on three of the four reads. */
  updatedAt: string;
  /**
   * ISO-8601 moment this item ENTERED a done-category status (MOTIR-4780), or
   * `null` on everything that has not finished.
   *
   * Carried on EVERY row rather than only on Recently finished ones, because
   * the four tabs share one row shape and one projection — a second DTO for the
   * one tab that renders a finish date would be the drift `HOME_WORK_ITEM_SELECT`
   * exists to prevent. It is also the axis the Recently-finished page cursor
   * keys on, so a caller that needs to reason about the boundary has the value
   * the boundary is made of.
   */
  completedAt: string | null;
  project: HomeProjectRefDto;
  viewerIsAssignee: boolean;
  viewerIsReporter: boolean;
}

/**
 * One OFFSET-paged window of a personal read (finding #57 — never a load-all).
 *
 * ⚠️ THIS WAS A KEYSET, AND THE TRADE IS DELIBERATE (MOTIR-4852). It carried an
 * opaque `nextCursor` encoding `(updatedAt, id)` — the exact pair the reads
 * order by — because a keyset keeps a page boundary stable while items are
 * updated underneath the reader. It can only ever offer NEXT, though: a keyset
 * has no notion of "page 7", so a reader could not see how far a tab went, jump,
 * or step back. The Workbench is not a feed — it is a bounded personal list
 * whose totals the tab strip already computes — so page numbers, a total and a
 * back button are worth a small amount of drift risk. On something unbounded the
 * trade would run the other way.
 *
 * The shape is `/items`' own (`PagedIssueListDto`), deliberately: one paging
 * vocabulary across the product, and `IssueListPager` consumes it unchanged.
 *
 * `page` is 1-based and CLAMPED — see `homeService`'s note on why an
 * out-of-range page lands on the last page rather than on an empty one.
 */
export interface HomePageDto {
  items: HomeWorkItemRowDto[];
  /** The size of the whole SET this page is a window on — the pager's denominator. */
  total: number;
  /** The 1-based page actually served, after clamping. */
  page: number;
  /** The window size — `HOME_PAGE_SIZE` unless the caller narrowed it. */
  pageSize: number;
}

/**
 * The size of each tab's SET (Subtask MOTIR-2653) — not of the current page.
 *
 * Both numbers ride together because the tab strip shows the size of the tab
 * the reader is NOT on as well as the one they are: that is what makes
 * switching an informed choice rather than a guess. `design/home/` suppresses
 * both when they are zero — a "0" beside a tab is noise a new user has to parse.
 */
export interface HomeTabCountsDto {
  /**
   * ⚠️ TRANSITIONAL, and owned by MOTIR-4782. The shipped `/home` page still
   * renders two tabs, and this card is backend-only — so the old number
   * survives beside the new ones until the page it feeds is replaced. It is
   * exactly `toDo + inProgress`, computed from the same round trip rather than
   * from a fifth query, so the two can never disagree.
   *
   * @deprecated Remove with `/home` when MOTIR-4782 lands `/workbench`.
   */
  myWork: number;
  /** Nothing has been started. */
  toDo: number;
  /** In flight — including the cards an agent has finished and a person has not looked at. */
  inProgress: number;
  /** Finished inside the rolling window (`HOME_FINISHED_WINDOW_DAYS`). */
  recentlyFinished: number;
  /**
   * What is waiting on YOU to approve.
   *
   * ⚠️ ALWAYS `0` FROM THIS CARD, and that is a scope boundary rather than a
   * placeholder to forget. MOTIR-4777 draws the Approvals tab's SLOT and ships
   * nothing behind it; the rows, the gate records and the approve/confirm
   * control are the sibling story's (MOTIR-4778). The number rides here now so
   * the tab strip can render a five-slot composition without a second DTO
   * change when that story lands.
   */
  approvals: number;
  watching: number;
}
