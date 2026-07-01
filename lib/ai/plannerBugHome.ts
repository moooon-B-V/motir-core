// The PLANNER-BUG HOME — the durable Epic + Story the AI self-learning loop
// files its `kind: bug`s under (MOTIR-1466; the home for MOTIR-965's inward
// auto-bug + MOTIR-967's outward sanitized meta-bug, via the internal
// `POST /api/internal/ai/work-items` route — MOTIR-1450).
//
// **Why a MARKER, not a numeric key.** Work-item keys (`MOTIR-<n>`) are
// allocated sequentially at seed time (`projectRepository.allocateWorkItemNumber`),
// so they are REALLOCATED on every reseed and drift whenever the seed data
// changes. A config value that hardcodes the numeric key of the home story
// (the old `MOTIR_META_BUG_PARENT_KEY = "MOTIR-1465"`) therefore dangles the
// moment the tenant is reseeded. So the home is instead targeted by a
// STABLE MARKER that never drifts: the config carries `PLANNER_BUG_HOME_MARKER`,
// and `aiWorkItemsService.fileBug` resolves it to whichever story currently
// carries `PLANNER_BUG_HOME_STORY_TITLE` in the target project. (notes.html
// mistake #100 — ship reseed-durable data keyed on a stable marker, never a
// positional/numeric id.)
//
// **The cross-repo config contract (notes.html mistake #48).** motir-core OWNS
// this contract — it seeds the home (`scripts/plan-seed/plannerBugHome.ts`) and
// resolves the marker. The sibling `motir-ai` repo is the CONSUMER: it sets
// `MOTIR_META_BUG_PARENT_KEY` (the `fly.toml` `[env]`) to the literal
// `PLANNER_BUG_HOME_MARKER` value below and passes it straight through as the
// `parentKey` of the bug-filing request — no motir-ai code change beyond the
// config value. Keep the two literals identical.
//
// The `@` prefix guarantees the marker can NEVER be mistaken for a real
// `<PROJECT>-<n>` identifier (identifiers are `[A-Z]+-[0-9]+`), so the resolver
// can branch on it unambiguously.

/** The stable, drift-proof handle the bug-filer's `parentKey` config carries to
 *  target the planner-bug home story. Set `motir-ai`'s `MOTIR_META_BUG_PARENT_KEY`
 *  to EXACTLY this literal. */
export const PLANNER_BUG_HOME_MARKER = '@planner-bug-home';

/** The home EPIC's title (a root epic in the `motir` project). The story below
 *  parents under it. Seeded by `seedPlannerBugHome`. */
export const PLANNER_BUG_HOME_EPIC_TITLE = 'Planner self-improvement — auto-reported quality bugs';

/** The home STORY's title — the actual bug parent. The marker resolves to the
 *  story carrying this title, so it is the ONE stable join key across reseeds
 *  (keys/ids are reallocated; the title is not). Both `seedPlannerBugHome` and
 *  the marker resolver import this constant, so it is defined in exactly one place. */
export const PLANNER_BUG_HOME_STORY_TITLE = 'Captured planning-mistake bugs';

/** Whether a `parentKey` value is the planner-bug-home marker (case-insensitive,
 *  trimmed) rather than a literal `<PROJECT>-<n>` identifier. */
export function isPlannerBugHomeMarker(parentKey: string): boolean {
  return parentKey.trim().toLowerCase() === PLANNER_BUG_HOME_MARKER;
}
