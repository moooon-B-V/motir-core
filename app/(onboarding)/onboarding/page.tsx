import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { readPendingIdea } from '@/lib/onboarding/pendingIdea';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { EmptyState } from '@/components/ui/EmptyState';
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

export default async function OnboardingEntrancePage() {
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

  // Onboarding-ran gate (Subtask 7.4 / MOTIR-1264): a project whose first plan was
  // approved + materialized has already produced its work-item tree — it never
  // re-enters onboarding, so the entrance redirects it to the real planning
  // surface, exactly as the discovery route does. A never-onboarded project (null
  // marker) sees the entrance — unless it already has existing work items
  // (MOTIR-1259: a manually-built or seeded tree → route to the migrate wizard).
  if (ctx.project.onboardingRanAt) redirect('/roadmap');

  // Existing-item gate (MOTIR-1259): a never-AI-planned project with a
  // non-empty work-item tree skips the start-fresh pre-plan path and routes to
  // the migrate wizard. Existing items ARE the project's understanding.
  if (!ctx.project.onboardingRanAt) {
    const itemCount = await workItemRepository.countProjectIssues(ctx.projectId, ctx.workspaceId);
    if (itemCount > 0) redirect('/onboarding/migrate');
  }

  const carriedIdea = await readPendingIdea();

  return <OnboardingEntrance carriedIdea={carriedIdea} />;
}
