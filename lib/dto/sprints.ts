// DTO types for the sprint domain (Story 4.1 · Subtask 4.1.3). The shape that
// crosses the API boundary — no Prisma row leaks (Date objects become ISO
// strings, the Prisma `SprintState` enum becomes a string union). The 4.2
// backlog / sprint-planning UI binds to these.

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
