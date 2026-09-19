// The PLANNER-BUG HOME — where the AI self-learning loop files its `kind: bug`s
// (MOTIR-1466; the home for MOTIR-965's inward auto-bug + MOTIR-967's outward
// sanitized meta-bug, via the internal `POST /api/internal/ai/work-items` route —
// MOTIR-1450).
//
// **Why a MARKER, not a numeric key.** Work-item keys (`MOTIR-<n>`) are
// allocated sequentially (`projectRepository.allocateWorkItemNumber`), so they
// drift whenever the tenant is rebuilt. A config value that hardcodes the home's
// numeric key (the old `MOTIR_META_BUG_PARENT_KEY = "MOTIR-1465"`) therefore
// dangles. So the home is targeted by a STABLE MARKER that never drifts: the
// config carries `PLANNER_BUG_HOME_MARKER`, and `aiWorkItemsService.fileBug`
// resolves it. (notes.html #100 — target env-specific data by a stable marker,
// never a positional/numeric id.)
//
// **The marker resolves to a FOLDER, and the bug is FILED, not parented (Story
// MOTIR-5818 · MOTIR-5822).** `fileBug` reads
// `bugDestinationService.resolvePlannerBug`: the project's
// `plannerBugDestinationFolderId`, else its product bug destination, else the
// project root — and sets the new bug's `folderId`, leaving `parentId` null, so
// the bug is a ROOT for readiness and rollups. Every rung is a legal answer, so
// filing never fails for want of a destination.
//
// It used to resolve to a STORY found by its title (MOTIR-2201), and that story
// became a 400-child container every read treats as ordinary open work — on the
// board, in the backlog, in reports, in semantic search. That is the shape
// MOTIR-5296 already retired for PRODUCT bugs, for the same reason: a folder is a
// placement with no status, no rollup, no readiness and no reporter. With the
// story lookup went `PlannerBugHomeNotProvisionedError`: it existed because a
// missing STORY left filing with nowhere to go, and a missing POINTER has a legal
// answer.
//
// **The cross-repo config contract (notes.html #48).** motir-core OWNS this
// contract — it resolves the marker. The sibling `motir-ai` repo is the
// CONSUMER: it sets `MOTIR_META_BUG_PARENT_KEY` (the `fly.toml` `[env]`) to the
// literal `PLANNER_BUG_HOME_MARKER` value below and passes it straight through as
// the `parentKey` — no motir-ai code knows what it means. Keep the two literals
// identical. (MOTIR-2201 and MOTIR-5822 each changed only what the marker
// RESOLVES TO, never the marker itself, so neither required a motir-ai change.)
//
// The `@` prefix guarantees the marker can NEVER be mistaken for a real
// `<PROJECT>-<n>` identifier (identifiers are `[A-Z]+-[0-9]+`), so the resolver
// can branch on it unambiguously.

/** The stable, drift-proof handle the bug-filer's `parentKey` config carries to
 *  target the planner-bug home. Set `motir-ai`'s `MOTIR_META_BUG_PARENT_KEY`
 *  to EXACTLY this literal. */
export const PLANNER_BUG_HOME_MARKER = '@planner-bug-home';

/** The OLD home EPIC's title — survives ONLY as the `ensure_planner_bug_home`
 *  migration's join key, kept in sync with its SQL literal by that migration's
 *  test. Nothing resolves through it. */
export const PLANNER_BUG_HOME_EPIC_TITLE = 'Planner self-improvement — auto-reported quality bugs';

/** The OLD home STORY's title — survives ONLY as a MIGRATION join key: the
 *  `ensure_planner_bug_home` migration that created the story, and the
 *  migration that empties and archives it (MOTIR-5824), each kept in sync with
 *  this literal by its own test. Nothing resolves a parent through it since
 *  MOTIR-5822. */
export const PLANNER_BUG_HOME_STORY_TITLE = 'Captured planning-mistake bugs';

/** Whether a `parentKey` value is the planner-bug-home marker (case-insensitive,
 *  trimmed) rather than a literal `<PROJECT>-<n>` identifier. */
export function isPlannerBugHomeMarker(parentKey: string): boolean {
  return parentKey.trim().toLowerCase() === PLANNER_BUG_HOME_MARKER;
}
