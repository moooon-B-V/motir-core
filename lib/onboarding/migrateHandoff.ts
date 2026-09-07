// The migrate-wizard hand-off gate (bug MOTIR-1725).
//
// MOTIR-1259 gave the two start-fresh onboarding entrances — `/onboarding` (the
// new-vs-existing fork) and `/onboarding/discovery` (the pre-plan loop) — an
// EXISTING-ITEM router: a never-AI-planned project whose tree is non-empty is
// sent to `/onboarding/migrate`, because existing items ARE that project's
// understanding and the 4-tier pre-plan should be skipped.
//
// That router is correct on the way IN and must stay (its `/onboarding` case is
// asserted by `tests/e2e/onboarding-ran-gate.spec.ts`). But it also fired on the
// way OUT: the migrate wizard's "Plan my project now" hands off to the planning
// surface, the router saw a non-empty tree and bounced the user straight back
// into the wizard — which, now past `audit_convention`, renders only its resume
// panel, whose CTA hands off again. Planning was unreachable for exactly the
// projects the wizard exists to serve (they imported a backlog, or MOTIR-1259
// routed them here *because* the tree was non-empty).
//
// The fix is to make the router directional rather than to weaken it: an ACTIVE
// migrate run that has advanced past set-up is proof the user has already been
// routed and has explicitly chosen to plan, so the entrance must let them
// through. `onboardingRanAt` cannot carry this signal — it is written only when
// the first plan is approved (`plansService`), which is downstream of the very
// planning surface being blocked.
//
// Kept as PURE predicates over the already-read DTO (no `server-only`, no I/O)
// so both Server Components share one decision and it is unit-testable without a
// database.

import type { MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';

/**
 * The wizard steps that exist only AFTER the required set-up (Connect · Index)
 * and the optional Import — i.e. the user pressed "Plan my project now" and the
 * run advanced past `audit_convention`. `done` is deliberately EXCLUDED: a
 * finished run is handled by the completed-run redirect, and treating it as
 * "reached planning" would let a long-finished migrate run permanently disarm
 * the entrance router.
 */
export const MIGRATE_PLANNING_STEPS: readonly MigrateOnboardingDto['step'][] = [
  'discovery',
  'generate',
  'review',
];

/**
 * Has this project's migrate run advanced past set-up into planning? Only an
 * `active` run counts — a `completed` or `failed` run is not an in-flight
 * hand-off and must not suppress the entrance router.
 */
export function migrateRunReachedPlanning(run: MigrateOnboardingDto | null): boolean {
  if (!run || run.status !== 'active') return false;
  return MIGRATE_PLANNING_STEPS.includes(run.step);
}

/**
 * Should a start-fresh onboarding entrance route this project to the migrate
 * wizard? True when the project already HAS something to plan from — an existing
 * tree (the MOTIR-1259 condition) **or a connected repository** (MOTIR-4756) —
 * AND its migrate run has not already handed off to planning (MOTIR-1725).
 *
 * | items | repository | before      | after                        |
 * |-------|------------|-------------|------------------------------|
 * |   0   | none       | start-fresh | start-fresh — **the FLOOR**  |
 * |   0   | connected  | start-fresh | **migrate wizard**           |
 * |  > 0  | any        | wizard      | wizard                       |
 *
 * ⚠️ ONLY ROW 2 MOVES, and it is the row this whole story is for. The predicate
 * read a single number, the item count, and never asked whether there was code —
 * so someone who connects their repository first and has not written a work item
 * yet was sent down the path built for people with nothing, and that path does
 * not read code (`MIGRATE_DISCOVERY_PROMPT` is passed only by the wizard).
 *
 * ⚠️ AND THE MANUAL CHOICE IS UNTOUCHED. The entrance's own *"I have an existing
 * project — migrate it"* affordance still routes wherever it routed; this
 * changes the DEFAULT, never what the user can pick.
 *
 * `repositoryConnected` rather than `repositoryIndexed` is deliberate: the
 * wizard's own INDEX step is what waits for a graph, so routing a
 * connected-but-unindexed project here lands it exactly where it can wait.
 *
 * Callers have already established that the project is never-AI-planned
 * (`onboardingRanAt == null`); that gate stays at the call site because its
 * redirect target differs (`/roadmap`, not the wizard).
 *
 * Still a PURE predicate over an already-read DTO — no I/O, no `server-only` —
 * so both Server Components share one decision and it stays unit-testable
 * without a database. The read that produces `repositoryConnected` is
 * `onboardingSubstrateService`'s, at the call site.
 */
export function shouldRouteToMigrateWizard(args: {
  itemCount: number;
  repositoryConnected: boolean;
  run: MigrateOnboardingDto | null;
}): boolean {
  if (args.itemCount <= 0 && !args.repositoryConnected) return false;
  return !migrateRunReachedPlanning(args.run);
}
