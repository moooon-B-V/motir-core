// The PLANNER-BUG HOME — the durable Epic + Story the AI self-learning loop
// files its `kind: bug`s under (MOTIR-1466; the home for MOTIR-965's inward
// auto-bug + MOTIR-967's outward sanitized meta-bug, via the internal
// `POST /api/internal/ai/work-items` route — MOTIR-1450).
//
// **Why a MARKER, not a numeric key.** Work-item keys (`MOTIR-<n>`) are
// allocated sequentially (`projectRepository.allocateWorkItemNumber`), so they
// drift whenever the tenant is rebuilt. A config value that hardcodes the home
// story's numeric key (the old `MOTIR_META_BUG_PARENT_KEY = "MOTIR-1465"`)
// therefore dangles. So the home is targeted by a STABLE MARKER that never
// drifts: the config carries `PLANNER_BUG_HOME_MARKER`, and
// `aiWorkItemsService.fileBug` resolves it via the home EPIC's title →
// its first story child (see below). (notes.html #100 — target env-specific
// data by a stable marker, never a positional/numeric id.)
//
// **Resolution keys on the EPIC title, not the story's.** The bug parent is the
// home epic's first STORY child, found via `PLANNER_BUG_HOME_EPIC_TITLE`. We key
// on the epic (whose title is fixed) rather than the story, because the live home
// story's title carries a "(the 7.6.8 inward loop)" suffix the canonical
// `PLANNER_BUG_HOME_STORY_TITLE` does not — resolving through the epic adopts the
// existing story regardless of its exact wording.
//
// **Provisioned by a MIGRATION, never a reseed.** The home is created by the
// idempotent `prisma/migrations/*_ensure_planner_bug_home` data migration, which
// `migrate deploy` applies to the deployed meta tenant with NO destructive
// reseed (a `db:seed` reseed wipes MCP-created items + the workspace PAT — never
// run it against the live tenant). The migration find-or-creates the Epic +
// Story keyed on the epic title (idempotent; a no-op where the home already
// exists or the meta tenant is absent).
//
// **The cross-repo config contract (notes.html #48).** motir-core OWNS this
// contract — it provisions the home (the migration) and resolves the marker. The
// sibling `motir-ai` repo is the CONSUMER: it sets `MOTIR_META_BUG_PARENT_KEY`
// (the `fly.toml` `[env]`) to the literal `PLANNER_BUG_HOME_MARKER` value below
// and passes it straight through as the `parentKey` — no motir-ai code change
// beyond the config value. Keep the two literals identical.
//
// The `@` prefix guarantees the marker can NEVER be mistaken for a real
// `<PROJECT>-<n>` identifier (identifiers are `[A-Z]+-[0-9]+`), so the resolver
// can branch on it unambiguously.

/** The stable, drift-proof handle the bug-filer's `parentKey` config carries to
 *  target the planner-bug home. Set `motir-ai`'s `MOTIR_META_BUG_PARENT_KEY`
 *  to EXACTLY this literal. */
export const PLANNER_BUG_HOME_MARKER = '@planner-bug-home';

/** The home EPIC's title (a root epic in the `motir` project) — the STABLE join
 *  key the marker resolves through (its first story child is the bug parent). The
 *  `ensure_planner_bug_home` migration find-or-creates keyed on this title; keep
 *  the two in sync (a migration test asserts it). */
export const PLANNER_BUG_HOME_EPIC_TITLE = 'Planner self-improvement — auto-reported quality bugs';

/** The canonical home STORY title the migration creates when the epic has no
 *  story child yet. NOT used for resolution (resolution is via the epic → its
 *  first story child, robust to the live story's title suffix). */
export const PLANNER_BUG_HOME_STORY_TITLE = 'Captured planning-mistake bugs';

/** Whether a `parentKey` value is the planner-bug-home marker (case-insensitive,
 *  trimmed) rather than a literal `<PROJECT>-<n>` identifier. */
export function isPlannerBugHomeMarker(parentKey: string): boolean {
  return parentKey.trim().toLowerCase() === PLANNER_BUG_HOME_MARKER;
}
