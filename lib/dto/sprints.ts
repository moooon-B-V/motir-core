// DTO types for the sprint domain (Story 4.1 · Subtask 4.1.3). The shape that
// crosses the API boundary — no Prisma row leaks (Date objects become ISO
// strings, the Prisma `SprintState` enum becomes a string union). The 4.2
// backlog / sprint-planning UI binds to these.

import type { RankedIssuePageDto } from '@/lib/dto/backlog';

/** Wire form of the Prisma `SprintState` enum. */
export type SprintStateDto = 'planned' | 'active' | 'complete';

/**
 * A sprint as the API returns it. `issueCount` is the sprint's committed
 * (non-archived) issue count — 0 for a freshly created planned sprint. The
 * three date fields are ISO-8601 strings (or null on a planned sprint whose
 * window isn't set / a sprint that hasn't completed).
 */
export interface SprintDto {
  id: string;
  name: string;
  goal: string | null;
  state: SprintStateDto;
  startDate: string | null;
  endDate: string | null;
  completedAt: string | null;
  sequence: number;
  issueCount: number;
  /**
   * The immutable scope-lock baseline captured by `startSprint` (Story 4.4.2):
   * `committedIssueCount` = the issue count at activation, `committedPoints` =
   * the `SUM(storyPoints)` at activation (a number, fractional-safe). Both are
   * `null` on a sprint that has not been started yet, and `committedPoints` is
   * `null` when the started sprint was wholly unestimated (the UI renders "—").
   */
  committedPoints: number | null;
  committedIssueCount: number | null;
}

/**
 * Input to `sprintsService.createSprint`. All fields optional: `name` defaults
 * to `"Sprint <n>"`, the rest are nullable planned-sprint metadata. Dates are
 * ISO-8601 strings (the route forwards the JSON body verbatim; the service
 * parses + validates them).
 */
export interface CreateSprintInput {
  name?: string;
  goal?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Input to `sprintsService.startSprint` (Story 4.4.2). `startDate` defaults to
 * "now" when omitted/null; `endDate` is the planned end of the sprint window
 * (validated `≥ startDate`); `name` optionally renames the sprint on start (the
 * Jira start-sprint dialog lets you confirm the name); `goal` optionally edits
 * the sprint goal as part of Start (Story 4.4.8 / finding #68 — the Jira start
 * dialog edits the goal inline, so it is stamped INSIDE the activation
 * transaction rather than via a separate pre-start PATCH). A `goal: undefined`
 * leaves the goal unchanged; an explicit `null` clears it. Dates are ISO-8601
 * strings (the route forwards the JSON body verbatim; the service parses +
 * validates them).
 */
export interface StartSprintInput {
  name?: string;
  goal?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Where a completing sprint's UNFINISHED issues go (Story 4.4.3). Either back to
 * the project **backlog** (the default — they keep their `backlogRank` and
 * re-appear in order), or into an existing **planned** sprint in the same
 * project (`{ sprintId }` — they are appended to that sprint's rank tail). A
 * carry-over into a NEW sprint = create it first (`createSprint`) then pass its
 * id here; there is deliberately no inline sprint-create in the complete flow.
 */
export type CarryOverDestination = 'backlog' | { sprintId: string };

/**
 * One in-sprint item that the sprint cannot finish on its own (Subtask 7.8.15) —
 * it is `blocked_by` work that is NOT done and NOT in the same sprint, so it can
 * never reach the ready set before the sprint ends. The exact set a caller
 * surfaces as "these items can't be finished; pull these blockers in or move
 * them to the backlog" (the re-validate-the-active-sprint rule, `motir-meta`
 * `plan-rules.md` #94).
 */
export interface SprintBlockerDto {
  /** The in-sprint item gated by out-of-sprint, not-done work (e.g. "MOTIR-1356"). */
  item: string;
  /** The blocking item — not done and not in this sprint (e.g. "MOTIR-1354"). */
  blockedBy: string;
  /** The blocker's raw workflow status key (e.g. "todo"). */
  blockerStatus: string;
  /** The blocker's sprint id, or `null` when it sits in the backlog. */
  blockerSprintId: string | null;
}

/**
 * Whether a sprint is FINISHABLE (Subtask 7.8.15) — the productized form of the
 * re-validate-the-active-sprint rule. A sprint is VALID ⟺ for EVERY in-sprint,
 * not-done item, its ENTIRE transitive `blocked_by` closure is `done` OR also in
 * the SAME sprint (walking the parent chain's blockers too — readiness cascades
 * down the hierarchy). `blockers` is empty when `valid`; otherwise it names each
 * in-sprint item gated by out-of-sprint, not-done work.
 */
export interface SprintValidityDto {
  /** The sprint that was validated (the active sprint when none was named). */
  sprintId: string;
  /** True ⟺ every in-sprint item's blocked_by closure is done or in this sprint. */
  valid: boolean;
  /** The in-sprint items gated by out-of-sprint, not-done work; empty when valid. */
  blockers: SprintBlockerDto[];
}

/**
 * Input to `sprintsService.completeSprint` (Story 4.4.3). `carryOverTo` defaults
 * to `'backlog'` when omitted. The done-category issues always STAY on the
 * completed sprint (the historical record); only the unfinished ones move to
 * the chosen destination.
 */
export interface CompleteSprintInput {
  carryOverTo?: CarryOverDestination;
}

/**
 * Input to `sprintsService.updateSprint` (rename / edit goal / adjust the
 * planned window). A `key: undefined` field is left unchanged; an explicit
 * `null` clears `goal` / a date. Dates are ISO-8601 strings.
 */
export interface UpdateSprintInput {
  name?: string;
  goal?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * The sprint report's points summary (Story 4.4.4) — the three figures Jira's
 * sprint report shows. `committed` is the IMMUTABLE scope-lock baseline
 * `startSprint` snapshotted at activation (`sprint.committedPoints`, 4.4.2) —
 * NOT the live roll-up, so the report can contrast what was committed against
 * what changed; it is `null` when the sprint was started wholly unestimated (the
 * UI renders "—"). `completed` is the `SUM(storyPoints)` over the sprint's
 * done-category issues NOW, and `notCompleted` the remainder — both REUSE Story
 * 4.3.3 `rollupForSprint` (the bounded grouped aggregate), never a re-sum. The
 * DTO stays TOTAL: it returns the numbers (0 when unestimated), and the UI owns
 * the "—" rendering (the 4.5.2 pattern).
 */
export interface SprintReportPointsDto {
  committed: number | null;
  completed: number;
  notCompleted: number;
}

/**
 * The sprint report (Story 4.4.4) — what got done vs. what did not, for a
 * `complete` sprint (the report) OR an `active` one (a live preview the complete
 * modal shows before confirming). Built to real-product SCALE (finding #57):
 * the counts + point figures are BOUNDED grouped aggregates, and the two issue
 * lists are CURSOR-PAGINATED (`RankedIssuePageDto` — the first bounded page +
 * `nextCursor` + the full `totalCount`), never a load-every-issue dump. The
 * "view all" deep-link the UI renders (`/items` filtered to the sprint, Story
 * 2.5) is built from `sprintId` — no extra field needed.
 *
 *   • `points` — the committed (baseline) / completed / not-completed summary.
 *   • `completed` — the done-category issues that shipped (paginated).
 *   • `incomplete` — the non-done-category issues that did not (paginated; the
 *     carry-over set 4.4.3 moved / will move).
 *   • `addedAfterStart` — the Jira "issues added during the sprint" figure: the
 *     count of issues associated with the sprint AFTER `startDate`, derived from
 *     the 1.4.6 revision trail (the immutable `committedIssueCount` baseline
 *     anchors it). Bounded (an aggregate over the sprint's own additions).
 */
export interface SprintReportDto {
  sprintId: string;
  state: SprintStateDto;
  points: SprintReportPointsDto;
  completed: RankedIssuePageDto;
  incomplete: RankedIssuePageDto;
  addedAfterStart: number;
}

/**
 * Options for `sprintsService.getSprintReport` (Story 4.4.4). The two issue
 * lists paginate INDEPENDENTLY — `completedCursor` / `incompleteCursor` are the
 * last-seen id of each (omit for page 1); `limit` (1..100, default 50) bounds
 * both. The cursors are separate so the UI can page one list without disturbing
 * the other.
 */
export interface GetSprintReportOptions {
  completedCursor?: string;
  incompleteCursor?: string;
  limit?: number;
}
