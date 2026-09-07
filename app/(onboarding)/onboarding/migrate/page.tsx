import { redirect } from 'next/navigation';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { searchParamsToEntries } from '@/lib/navigation/searchParamsToEntries';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { MigrateWizard } from './_components/MigrateWizard';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';

// The migrate-onboarding wizard (Story 7.15 · MOTIR-934) — the stepped,
// resumable set-up shell for onboarding an EXISTING codebase. Full-screen in
// the `(onboarding)` route group (no app shell — a minimal brand bar), at its
// own route `/onboarding/migrate` (the issue importer MOTIR-942 occupies
// `/onboarding/import`; the entrance's existing-project door routes here).
//
// A Server Component that reads the project's migrate run — its SAVED step —
// via the state-machine service (4-layer: this page calls ONE service method,
// no DB), and hands it to the client island. Re-opening resumes at the saved
// step (never restarts). The client island drives the step transitions through
// the migrate API routes (advance / skip-import / index-status poll); it never
// calls the service layer directly.
export default async function MigrateOnboardingPage({
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
  if (!session) redirect('/sign-in?next=%2Fonboarding%2Fmigrate');

  const ctx = await getActiveProject();
  if (!ctx) redirect(ONBOARDING_ENTRY_PATH);

  // Onboarding-ran gate (bug MOTIR-2090) — the SAME gate `/onboarding` and
  // `/onboarding/discovery` carry (Subtask 7.4 / MOTIR-1264). Without it this
  // route was the side door left open by the marker: its only redirect was the
  // completed-run one below, and the marker and the run are written by different
  // things — `markOnboardingRan` stamps the marker at plan approve+materialize
  // (and, for the dogfood project, at the seed / the MOTIR-1799 operator stamp),
  // while the run reaches `completed` ONLY by the wizard walking its `review →
  // done` hop. So an established project could keep a permanently `active` run
  // and resume the set-up wizard over a shipped tree by typing the URL.
  //
  // It cannot strand a legitimate in-flight run. `onboardingRanAt` is null for
  // the whole migrate journey — checked against every caller of
  // `markOnboardingRan`: `plansService.approvePlan` (the approve that ENDS the
  // journey), `scripts/plan-seed/dogfoodProject.ts`, `scripts/stampOnboardingRan.ts`
  // (both operator/seed paths, never a user mid-wizard). A non-null marker
  // therefore means "already established", never "half-way through".
  //
  // Not the MOTIR-1725 hazard, which is the opposite direction: that bug was the
  // existing-item ROUTER on the two start-fresh entrances bouncing the wizard's
  // own hand-off back INTO the wizard, so the fix had to make the inbound router
  // directional (`shouldRouteToMigrateWizard`). This gate is outbound — it only
  // sends a project the marker already calls established AWAY from the wizard —
  // and it is unreachable on the hand-off path, which runs while the marker is
  // still null.
  //
  // THE ORPHANED RUN ROW is left in place, deliberately. It cannot drive any
  // surface once this gate closes: every reader of the run is marker-gated (this
  // page, `/onboarding`, `/onboarding/discovery`) or run-id-scoped (the migrate
  // API routes), and the "Resume onboarding" door's server gate is
  // `onboardingRanAt == null` too. Terminating it is a WRITE, and the right site
  // is the marker's writer, not this read — a GET render must not mutate. The
  // marker also has a producer this page cannot see: `approvePlan` stamps it,
  // then the wizard's client lands the final `review → done` advance, so a tab
  // closed in between leaves an `active` run on a legitimately-established
  // project. That is a defect in the run's terminal CONDITION (it completes only
  // if the client walks the last hop — the same pull-only shape as MOTIR-2082),
  // filed as MOTIR-2092 rather than bolted onto this gate.
  if (ctx.project.onboardingRanAt) redirect(back ?? '/roadmap');

  const run = await migrateOnboardingService.getForProject(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // A completed run means the project's plan was approved — onboarding is done.
  // Land the user on the roadmap, not the wizard.
  if (run?.status === 'completed') redirect(back ?? '/roadmap');

  return (
    <MigrateWizard
      initialRun={run}
      projectName={ctx.project.name}
      userInitial={(session.user.name?.[0] ?? 'M').toUpperCase()}
    />
  );
}
