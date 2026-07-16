import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { readPendingIdea } from '@/lib/onboarding/pendingIdea';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
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

export default async function OnboardingPage() {
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
  if (ctx.project.onboardingRanAt) redirect('/roadmap');

  // Existing-item gate (MOTIR-1259): a never-AI-planned project with a
  // non-empty work-item tree skips the start-fresh discovery loop and routes to
  // the migrate wizard. Existing items ARE the project's understanding.
  if (!ctx.project.onboardingRanAt) {
    const itemCount = await workItemRepository.countProjectIssues(ctx.projectId, ctx.workspaceId);
    if (itemCount > 0) redirect('/onboarding/migrate');
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
