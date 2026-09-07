import { redirect } from 'next/navigation';
import { onboardingReturnHref } from '@/lib/planning/onboardingReturn';
import { searchParamsToEntries } from '@/lib/navigation/searchParamsToEntries';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { readPendingIdea } from '@/lib/onboarding/pendingIdea';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { readOnboardingSubstrate } from '@/lib/services/onboardingSubstrateService';
import { shouldRouteToMigrateWizard } from '@/lib/onboarding/migrateHandoff';
import { EmptyState } from '@/components/ui/EmptyState';
import { DiscoveryOnboarding } from '@/components/onboarding/DiscoveryOnboarding';

// The authed discovery onboarding route (Subtask 7.3.5 / MOTIR-833) — where the
// public front door (7.3.14) lands the visitor after auth (`ONBOARDING_ENTRY_PATH
// = /onboarding`). A Server Component that gates on session + active project (the
// established getSession + getActiveProject pattern, mirroring /ready + /items),
// READS the preserved idea (7.3.14 cookie) to seed the loop's first turn, and
// hands off to the client island that drives the FORWARD gated review loop.
//
// The loop reads its resumable state from the 7.3.70 `/api/ai/pre-plan` seam and
// streams the conductor over the 7.3.4 `/api/ai/chat` SSE, so this page does no
// AI read itself — it only resolves the actor + the seed idea. The polished
// two-pane shell (canvas roadmap + step host) is the onboarding shell, Subtask
// 7.3.11 / MOTIR-840, which composes the chat + review surfaces built here.
//
// EXISTING-ITEM DETECTION (MOTIR-1259): a never-AI-planned project that already
// has a committed work-item tree redirects to the migrate wizard
// (`/onboarding/migrate`) instead of entering the start-fresh discovery loop.
// Existing items ARE the project's understanding — the 4-tier pre-plan is skipped.

export default async function OnboardingPage({
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
  if (!ctx) {
    const t = await getTranslations('onboarding.chat');
    return (
      <div className="p-6">
        <EmptyState title={t('noProjectTitle')} description={t('noProjectBody')} />
      </div>
    );
  }

  // Onboarding-ran gate (Subtask 7.4 / MOTIR-1264): a project whose FIRST plan
  // was approved + materialized has already produced its work-item tree through
  // onboarding — never show the pre-plan canvas again. Redirect to the project's
  // real planning surface. A NEVER-onboarded project (existing tree but no
  // materialized plan — a db:seed tree or a migrate-existing project, MOTIR-815)
  // has a null marker and still enters onboarding; the 7.3 restore resumes an
  // in-progress session from there — unless it already has existing work items
  // (MOTIR-1259: route to the migrate wizard instead of the start-fresh path).
  if (ctx.project.onboardingRanAt) redirect(back ?? '/roadmap');

  // Existing-item gate (MOTIR-1259): a never-AI-planned project with a
  // non-empty work-item tree skips the start-fresh discovery loop and routes to
  // the migrate wizard. Existing items ARE the project's understanding.
  //
  // …UNLESS the migrate wizard already handed off to planning (MOTIR-1725): the
  // gate is an inbound router, and bouncing the wizard's own "Plan my project
  // now" back into the wizard made planning unreachable for every migrate
  // project with a tree. The run is read only when the gate would otherwise
  // fire, so the empty-project path keeps its single query.
  //
  // ⚠️ AND IT ASKS BOTH HALVES NOW (MOTIR-4756) — the entrance's own comment
  // carries the reason. The two Server Components share ONE decision, so they
  // share the read that feeds it: a project with a connected repository and no
  // work items belongs in the wizard from either door.
  if (!ctx.project.onboardingRanAt) {
    const substrate = await readOnboardingSubstrate(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
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

  const initialIdea = await readPendingIdea();

  return (
    <DiscoveryOnboarding
      initialIdea={initialIdea}
      projectKey={ctx.project.identifier}
      projectName={ctx.project.name}
    />
  );
}
