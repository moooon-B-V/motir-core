// THE OFFBOARDING VOCABULARY (MOTIR-2166 ·
// `docs/decisions/code-graph-index-fleet.md` §14).
//
// The window, the sentinel and the trigger names live here rather than at their
// call sites for the reason §14.3 gives about the window specifically: it is
// "one named constant in motir-core … interpolated into the copy that states it
// (MOTIR-2171) rather than retyped — so the promise and the behaviour cannot
// drift." A product that tells the user "30 days" in a dialog and enforces
// something else in a service has expressed its enforcement in terms it does not
// control (`notes.html` #185). One value, both readers.

/**
 * How long a derived code graph is retained after a windowed offboarding trigger
 * — §14's decided retention window.
 *
 * ⚠️ **This value is USER-FACING.** MOTIR-2171 renders it in the disconnect /
 * archive / delete dialogs. Changing it changes a promise made in the product's
 * own copy, not just a sweep's timing.
 */
export const CODE_GRAPH_RETENTION_WINDOW_DAYS = 30;

/** The same window in milliseconds — what `dueAt` is computed from. */
export const CODE_GRAPH_RETENTION_WINDOW_MS =
  CODE_GRAPH_RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The `repoRef` standing for EVERY repo of a project — the project-archive and
 * workspace-delete arms of §14.3, which motir-ai's `POST /v1/code-graph/offboard`
 * serves by OMITTING `repoRef` entirely.
 *
 * A sentinel rather than NULL, deliberately. Postgres treats NULLs as distinct
 * in a unique index, so a nullable `repoRef` would let two project-wide rows for
 * the same project both insert — and Prisma cannot express a null component in
 * the compound-unique `where` that an upsert needs. §14's own design says
 * "enqueue is an upsert"; the sentinel is what makes that true.
 *
 * It cannot collide with a real value: a `repoRef` is always `owner/name`
 * (`lib/workItems/targetRepo.ts`), and no host permits `*` in either segment.
 */
export const OFFBOARD_ALL_REPOS = '*';

/**
 * WHICH lifecycle trigger enqueued a removal — §14.3's four arms, plus the
 * reconciliation the backstop may add later.
 *
 * Text in the database rather than a Postgres enum (the `FleetInFlightSlot.workload`
 * precedent): a new trigger should be a one-line registry edit, not a migration.
 */
export type CodeGraphOffboardReason =
  /** ONE repo disconnected from the workspace. Windowed. */
  | 'repo_disconnected'
  /** A whole provider connection disconnected — every repo on it. Windowed. */
  | 'connection_disconnected'
  /** A project archived — this product's terminal project action. Windowed. */
  | 'project_archived'
  /** A workspace hard-deleted. IMMEDIATE — see {@link isImmediate}. */
  | 'workspace_deleted';

/**
 * Whether a trigger removes IMMEDIATELY rather than after the window (§14.3).
 *
 * Only the workspace delete does, and the reason is not severity — it is that a
 * hard delete cascades away every surface a user could undo into. The other
 * three leave the project row standing, so the scope stays readable and a
 * re-connect can cancel the pending row; that is what makes the window a grace
 * period rather than a delay. "A grace period the user cannot reach is not a
 * grace period," so the workspace arm has none and a window there would only
 * extend retention.
 */
export function isImmediate(reason: CodeGraphOffboardReason): boolean {
  return reason === 'workspace_deleted';
}

/**
 * When a removal enqueued now becomes due — `now` for the immediate arm,
 * `now + `{@link CODE_GRAPH_RETENTION_WINDOW_DAYS}` days` for the other three.
 *
 * `now` is injectable so a test can pin the boundary rather than assert a
 * timestamp window around wall-clock (`notes.html`: a timestamp assertion is a
 * window, not an equality — unless you own the clock, which here you can).
 */
export function offboardDueAt(reason: CodeGraphOffboardReason, now: Date = new Date()): Date {
  return isImmediate(reason)
    ? new Date(now.getTime())
    : new Date(now.getTime() + CODE_GRAPH_RETENTION_WINDOW_MS);
}

/** One pending removal's scope — the tenant coordinates motir-ai resolves by. */
export interface OffboardScope {
  coreWorkspaceId: string;
  coreProjectId: string;
  /** `owner/name`, or {@link OFFBOARD_ALL_REPOS} for the whole project. */
  repoRef: string;
}
