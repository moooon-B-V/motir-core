import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { readPendingIdea } from '@/lib/onboarding/pendingIdea';
import { EmptyState } from '@/components/ui/EmptyState';
import { OnboardingEntrance } from '@/components/onboarding/OnboardingEntrance';

// The onboarding ENTRANCE route (Subtask 7.22.4 / MOTIR-1462) — the new-vs-existing
// fork the user lands on at `/onboarding`, designed by MOTIR-1461
// (`design/onboarding-entrance/`). It replaces the old direct render of the
// discovery chat here: the chat now lives at `/onboarding/discovery`, and this
// screen ROUTES into it (Start planning → discovery, seeded with the idea) or
// hands off to the import wizard (→ `/onboarding/import`, owned by 7.15/7.17).
//
// A Server Component that gates exactly like the discovery route (session →
// active project → the onboarding-ran marker), then reads the preserved idea
// (the motir.co hero cookie, MOTIR-1458) to pre-fill the box. It does NO AI read
// and imports nothing from `motir-ai` (the open-core invariant) — the idea
// reaches the planner only through the 7.3.4 chat route the discovery surface
// drives, after the entrance forwards to it.

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
  // marker) sees the entrance.
  if (ctx.project.onboardingRanAt) redirect('/roadmap');

  const carriedIdea = await readPendingIdea();

  return <OnboardingEntrance carriedIdea={carriedIdea} />;
}
