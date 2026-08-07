import type { Prisma } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';

// The DOGFOOD project's onboarding-ran marker (MOTIR-1799). The `motir` project
// the seed builds is Motir's own plan — an ESTABLISHED project, not a project
// waiting to be onboarded — so the seed stamps `Project.onboardingRanAt` for it
// rather than leaving it null.
//
// WHY the seed stamps it (and why this is not a bug to revert). Normally the
// marker is written by `plansService.approvePlan`, the first time a project's
// generated plan is approved and materialized. The meta project never walks that
// journey: its plan is authored directly (the seed tree + the live tenant), and
// Yue's decision on MOTIR-1799 is that MOTIR reaches established status by
// STAMPING the marker, not by walking a wizard. `motir-ai`'s
// `src/seed/dogfoodDirectionDocs.ts` (MOTIR-1354) already seeds Motir's own four
// direction-tier docs on exactly that argument — "so the tier-doc viewer shows
// real dogfood content, not an empty state". Leaving the marker null while that
// content is seeded is the inconsistency; this closes it.
//
// WHAT it unlocks, all of which already have content behind them: `/onboarding`
// and `/onboarding/discovery` redirect to `/roadmap`; `/planning` opens the
// planning workspace; the resume-onboarding door hides
// (`lib/onboarding/resumeVisibility.ts`); and `/roadmap`'s planning-origin
// cluster renders over the seeded tier docs. `/code-health` is unaffected — it
// keys off the repo grant, not this marker.
//
// ⚠️ The TEST project's marker deliberately stays NULL — see `./testProject.ts`.
// The two projects are not interchangeable: the test bed exists precisely so one
// project still lands in `/onboarding`. Do not collapse them.
//
// Split out (mirroring `./testProject.ts` and the other plan-seed helpers) so it
// is testable without running the whole self-invoking `seed.ts` script.

/**
 * Stamp the dogfood project's `onboardingRanAt` marker inside the seed's
 * transaction. Delegates to `projectRepository.markOnboardingRan`, whose
 * null-guarded `updateMany` makes the write SET-ONCE: a project that already
 * carries a marker is a clean no-op rather than an overwrite, so this is safe on
 * every reseed.
 *
 * @returns `true` when this call wrote the marker, `false` when it was already set.
 */
export async function markDogfoodProjectEstablished(
  projectId: string,
  at: Date,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  return (await projectRepository.markOnboardingRan(projectId, at, tx)) === 1;
}
