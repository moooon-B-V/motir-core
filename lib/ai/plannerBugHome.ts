// The PLANNER-BUG HOME — the durable Epic the AI self-learning loop files its
// `kind: bug`s under (MOTIR-1466; the home for MOTIR-965's inward auto-bug +
// MOTIR-967's outward sanitized meta-bug, via the internal
// `POST /api/internal/ai/work-items` route — MOTIR-1450).
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
// **The home EPIC ITSELF is the bug parent — ONE hop, no positional read
// (MOTIR-2201).** Resolution finds the project's `epic` whose title is
// `PLANNER_BUG_HOME_EPIC_TITLE`; that epic IS the parent. `epic → bug` is
// matrix-legal (`lib/issues/parentRules.ts`), and it is where the live tenant's
// auto-filed bugs already sit.
//
// It previously took a SECOND hop — the epic's first child of kind `story` —
// and that hop is what broke: the live home story was re-parented under another
// epic on 2026-08-05, the home epic was left with only `bug`/`task` children,
// and every auto-filed planner bug 404'd silently. `getFirstChildOfKind(epic,
// 'story')` is a POSITIONAL READ OF MUTABLE STRUCTURE wearing the clothes of a
// stable marker — precisely the fragility the marker was introduced to escape
// when it replaced the numeric key. The epic cannot suffer the same fate: `epic`
// is root-only in the kind-parent matrix, so it cannot be re-parented, and
// nothing that happens BENEATH it changes what the marker resolves to. A
// `move_to_parent` can no longer void this invariant. (The helper the second hop
// used was deleted with it, in both the service and the repository, so the
// positional read cannot be reintroduced by accident.)
//
// **A missing home is LOUD, never a quiet 404 (MOTIR-2201).** The old code threw
// `WorkItemNotFoundError`, which the route maps to 404 — indistinguishable from
// "the caller named a parentKey that doesn't exist", and the consumer's filing
// path swallows failures by design (motir-ai's `fileBugForLesson` logs and moves
// on, correctly, since capture must not depend on filing). So the loop could be
// deaf for weeks with nothing red anywhere. An absent home is a SERVER INVARIANT
// breach, not a caller error: it now throws `PlannerBugHomeNotProvisionedError`
// → **500** `planner_bug_home_not_provisioned`, logged at error level with the
// project and the title looked for. Same reasoning — and same shape — as
// `SystemPrincipalNotProvisionedError` in `lib/ai/serviceAuth.ts`.
//
// **Provisioned by a MIGRATION, never a reseed.** The home was created by the
// idempotent `prisma/migrations/*_ensure_planner_bug_home` data migration, which
// `migrate deploy` applies to the deployed meta tenant with NO destructive
// reseed (a `db:seed` reseed wipes MCP-created items + the workspace PAT — never
// run it against the live tenant). NOTE that a migration runs EXACTLY ONCE per
// database: it is a one-shot backfill, not a standing guarantee. That is why the
// thing it provisions must be un-voidable by ordinary plan edits (above) and why
// its absence must be loud (above) rather than re-checked by a migration that
// will never run again.
//
// **The cross-repo config contract (notes.html #48).** motir-core OWNS this
// contract — it provisions the home (the migration) and resolves the marker. The
// sibling `motir-ai` repo is the CONSUMER: it sets `MOTIR_META_BUG_PARENT_KEY`
// (the `fly.toml` `[env]`) to the literal `PLANNER_BUG_HOME_MARKER` value below
// and passes it straight through as the `parentKey` — no motir-ai code change
// beyond the config value. Keep the two literals identical. (MOTIR-2201 changed
// only what the marker RESOLVES TO, never the marker itself, so no motir-ai
// change was required.)
//
// The `@` prefix guarantees the marker can NEVER be mistaken for a real
// `<PROJECT>-<n>` identifier (identifiers are `[A-Z]+-[0-9]+`), so the resolver
// can branch on it unambiguously.

/** The stable, drift-proof handle the bug-filer's `parentKey` config carries to
 *  target the planner-bug home. Set `motir-ai`'s `MOTIR_META_BUG_PARENT_KEY`
 *  to EXACTLY this literal. */
export const PLANNER_BUG_HOME_MARKER = '@planner-bug-home';

/** The home EPIC's title (a root epic in the `motir` project) — the STABLE join
 *  key the marker resolves through, and the bug parent itself. The
 *  `ensure_planner_bug_home` migration find-or-creates keyed on this title; keep
 *  the two in sync (a migration test asserts it). */
export const PLANNER_BUG_HOME_EPIC_TITLE = 'Planner self-improvement — auto-reported quality bugs';

/** The home STORY title the `ensure_planner_bug_home` migration creates under
 *  the epic. MIGRATION HISTORY ONLY — resolution has never keyed on it and, as
 *  of MOTIR-2201, no longer reads a story child at all. It stays exported
 *  because `tests/integration/migrations/ensure-planner-bug-home.test.ts`
 *  asserts the migration's SQL literal matches this constant. */
export const PLANNER_BUG_HOME_STORY_TITLE = 'Captured planning-mistake bugs';

/** Whether a `parentKey` value is the planner-bug-home marker (case-insensitive,
 *  trimmed) rather than a literal `<PROJECT>-<n>` identifier. */
export function isPlannerBugHomeMarker(parentKey: string): boolean {
  return parentKey.trim().toLowerCase() === PLANNER_BUG_HOME_MARKER;
}

/**
 * The planner-bug home epic is missing from the target project — a SERVER
 * INVARIANT breach, not a caller error (MOTIR-2201).
 *
 * Deliberately NOT `WorkItemNotFoundError`: that maps to 404, which reads as
 * "you named a parent that doesn't exist" and is exactly how a broken home went
 * unnoticed while the self-learning loop's filing path swallowed it. Surfaced as
 * 500 so a mis-provisioned meta tenant is loud — the same choice, for the same
 * reason, as `SystemPrincipalNotProvisionedError`.
 */
export class PlannerBugHomeNotProvisionedError extends Error {
  readonly httpStatus = 500;
  readonly code = 'planner_bug_home_not_provisioned' as const;
  constructor(projectKey: string) {
    super(
      `The planner-bug home is not provisioned in project ${projectKey}: no epic titled "${PLANNER_BUG_HOME_EPIC_TITLE}". The ${PLANNER_BUG_HOME_MARKER} marker cannot resolve, so no planner bug can be filed. Re-create the home epic with that exact title (see prisma/migrations/20260701130000_ensure_planner_bug_home).`,
    );
    this.name = 'PlannerBugHomeNotProvisionedError';
  }
}
