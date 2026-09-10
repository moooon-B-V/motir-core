import { redirect } from 'next/navigation';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { searchParamsToEntries } from '@/lib/navigation/searchParamsToEntries';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { readPendingIdea } from '@/lib/onboarding/pendingIdea';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { readOnboardingSubstrate } from '@/lib/services/onboardingSubstrateService';
import { shouldRouteToMigrateWizard } from '@/lib/onboarding/migrateHandoff';
import { OnboardingEntrance } from '@/components/onboarding/OnboardingEntrance';

// The onboarding ENTRANCE route (Subtask 7.22.4 / MOTIR-1462) — the new-vs-existing
// fork the user lands on at `/onboarding`, designed by MOTIR-1461
// (`design/onboarding-entrance/`). It replaces the old direct render of the
// discovery chat here: the chat now lives at `/onboarding/discovery`, and this
// screen ROUTES into it (Start planning → discovery, seeded with the idea) or
// hands off to the migrate wizard (→ `/onboarding/migrate`, owned by 7.15 /
// MOTIR-934 — whose optional Import step reaches the importer at `/onboarding/import`).
//
// A Server Component that gates exactly like the discovery route (session →
// active project → the onboarding-ran marker), then reads the preserved idea
// (the motir.co hero cookie, MOTIR-1458) to pre-fill the box. It does NO AI read
// and imports nothing from `motir-ai` (the open-core invariant) — the idea
// reaches the planner only through the 7.3.4 chat route the discovery surface
// drives, after the entrance forwards to it.
//
// EXISTING-ITEM DETECTION (MOTIR-1259): a never-AI-planned project that already
// has a committed work-item tree routes directly to the migrate wizard
// (`/onboarding/migrate`) instead of showing the start-fresh entrance. Existing
// items ARE the project's understanding — the 4-tier pre-plan is skipped.

export default async function OnboardingEntrancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ⚠️ WHERE A FINISHED JOURNEY LANDS IS NOT ALWAYS `/roadmap` (MOTIR-4770). A
  // user who reached onboarding from the plan window was SENT here by a routing
  // verdict, and they were promised they would land back in the window they
  // opened. The return address rides the query the hand-off wrote; `null` means
  // they came in by another door — the entrance, a bookmark, a fresh sign-up —
  // and those keep the destination they always had.
  const back = onboardingReturnHref(
    new URLSearchParams(searchParamsToEntries(await searchParams)),
    'completed',
  );

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does — the only null
  // left is a session-less request — and it redirects rather than rendering.
  if (!ctx) redirect('/sign-in');

  // Onboarding-ran gate (Subtask 7.4 / MOTIR-1264): a project whose first plan was
  // approved + materialized has already produced its work-item tree — it never
  // re-enters onboarding, so the entrance redirects it to the real planning
  // surface, exactly as the discovery route does. A never-onboarded project (null
  // marker) sees the entrance — unless it already has existing work items
  // (MOTIR-1259: a manually-built or seeded tree → route to the migrate wizard).
  if (ctx.project.onboardingRanAt) redirect(back ?? '/roadmap');

  // Existing-item gate (MOTIR-1259): a never-AI-planned project with a
  // non-empty work-item tree skips the start-fresh pre-plan path and routes to
  // the migrate wizard. Existing items ARE the project's understanding.
  //
  // …UNLESS the migrate wizard already handed off to planning (MOTIR-1725) —
  // this route was also the universal "Plan with AI"
  // target, so an unconditional bounce here trapped the hand-off as well.
  //
  // ⚠️ AND THE ROUTER ASKS BOTH HALVES OF THE QUESTION NOW (MOTIR-4756). It read
  // the item count alone, so a project with a connected repository and zero work
  // items was sent down the start-fresh path — the one path that does NOT read
  // code. The substrate read answers "what does this project already have?" once,
  // and the predicate decides on both inputs.
  if (!ctx.project.onboardingRanAt) {
    const substrate = await readOnboardingSubstrate(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // The run is only consulted when something could route us to the wizard —
    // its only job here is the MOTIR-1725 directional guard, which has nothing to
    // suppress on a project the predicate would not route anyway.
    const run =
      substrate.itemCount > 0 || substrate.repositoryConnected
        ? await migrateOnboardingService.getForProject(ctx.projectId, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
          })
        : null;
    if (
      shouldRouteToMigrateWizard({
        itemCount: substrate.itemCount,
        repositoryConnected: substrate.repositoryConnected,
        run,
      })
    ) {
      redirect('/onboarding/migrate');
    }
  }

  const carriedIdea = await readPendingIdea();

  return <OnboardingEntrance carriedIdea={carriedIdea} />;
}
