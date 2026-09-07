import type { ProjectDTO } from '@/lib/dto/projects';

/**
 * The `context` key the ONBOARDING fact rides on, as motir-ai's planning job
 * reads it (MOTIR-4736 producer ↔ MOTIR-4737 consumer).
 *
 * Declared `as const` so a computed-key literal (`{ [FIELD]: value }`) still
 * type-checks against `JobContextBag`'s `onboarding` — the call sites therefore
 * name this constant and never re-spell the string. That is the same discipline
 * `RECORD_PLANNING_MISTAKES_CONTEXT_FIELD` states one file over, and for the same
 * reason: there is no shared type across the open-core boundary, so the name is a
 * string agreement between two codebases and a typo on either side is not a type
 * error.
 */
export const ONBOARDING_CONTEXT_FIELD = 'onboarding' as const;

/**
 * Is this project still ONBOARDING — i.e. has it never had a plan approved?
 *
 * ⚠️ IT IS A FACT ABOUT THE PROJECT'S HISTORY, NOT ABOUT ITS TREE, and that is
 * the whole reason it has to cross the wire. motir-core holds the history in one
 * column: `Project.onboardingRanAt` is null from the moment the project exists
 * until `plansService.approvePlan` stamps it via `markOnboardingRan`, and every
 * onboarding surface gates on exactly that (`/onboarding`, `/onboarding/discovery`,
 * `/onboarding/migrate`, the resume door — MOTIR-1264). motir-ai cannot read it,
 * so before this field it INFERRED onboarding from an EMPTY COMMITTED TREE
 * (`mayPlanTheFirstTree`, MOTIR-4178).
 *
 * That inference is right for the start-fresh path and WRONG for the one
 * onboarding journey built to have work items before its first plan: the migrate
 * wizard's optional import step (MOTIR-934 / MOTIR-1643) writes a Jira / Linear /
 * GitHub / Plane / CSV backlog into real work items, and only THEN kicks the
 * first plan — with a prompt that asks the planner to de-duplicate against it. A
 * tree-shaped guess reads that run as continued work.
 *
 * ⚠️ NAMED FOR THE FACT, NOT FOR A WIZARD STEP. It is true for the start-fresh
 * discovery path, for the migrate path with or without a completed import, and
 * for a bare `POST /api/ai/plan/generate` on a never-planned project alike —
 * which is why the SERVICE reads the marker and no caller passes it by hand.
 *
 * ⚠️ AND ABSENT IS NOT `false` ON THE WIRE. `false` means *this project has
 * already had a plan approved*; ABSENT means *the producer predates this field*,
 * which the consumer must fall back on its own inference for. So every planning
 * submit sends it UNCONDITIONALLY (`false` once the marker is stamped), and the
 * consumer's fallback exists for version skew alone. Spreading it conditionally
 * would make a live core indistinguishable from an old one.
 *
 * A pure read of a column the caller already holds: `ProjectContext.project` is a
 * `ProjectDTO` and the marker rides the BASE DTO, so this costs no round-trip —
 * unlike `resolveRecordPlanningMistakesForJob`, which has to read a settings row.
 */
export function onboardingContextFor(
  project: Pick<ProjectDTO, 'onboardingRanAt'> | { onboardingRanAt: Date | string | null },
): boolean {
  return project.onboardingRanAt == null;
}
