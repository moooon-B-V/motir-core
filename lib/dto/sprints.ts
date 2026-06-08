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
