import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { MotirAiError } from '@/lib/ai/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { isDirectionDocKind } from '@/lib/onboarding/directionDoc';
import { findTierDoc, producedTierKinds } from '@/lib/onboarding/preplanClient';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import { DirectionDocFullPage } from '@/app/(authed)/direction/[tier]/_components/DirectionDocFullPage';

// GET /onboarding/direction/[tier] (MOTIR-1366) — the SHELL-LESS full page for one
// pre-plan direction-tier doc, opened in a NEW TAB from the onboarding tier-doc
// modal's "Open full page". It sits in the `(onboarding)` route group, so it gets
// that group's full-bleed, session-gated layout WITHOUT the authed app shell — the
// user is still in the immersive onboarding flow and hasn't seen the app yet. The
// in-shell twin (`/direction/[tier]`, under `(authed)`) is what the roadmap canvas
// uses; both render the SAME `DirectionDocFullPage`, here with `origin="onboarding"`
// (Back → /onboarding, cross-links stay shell-less).

export default async function OnboardingDirectionDocPage({
  params,
}: {
  params: Promise<{ tier: string }>;
}) {
  const { tier } = await params;
  if (!isDirectionDocKind(tier)) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <EmptyState
        title="No active project"
        description="Pick a project to read its direction docs."
      />
    );
  }

  let state: PreplanStateDTO | null = null;
  let error = false;
  try {
    state = await aiPreplanService.getPreplanState(ctx);
  } catch (err) {
    if (err instanceof MotirAiError) error = true;
    else throw err;
  }

  return (
    <main className="min-h-screen overflow-y-auto bg-(--el-surface) px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-[60rem]">
        <DirectionDocFullPage
          tier={tier}
          doc={state ? findTierDoc(state, tier) : null}
          catalog={state?.catalog ?? null}
          availableDocs={state ? producedTierKinds(state) : []}
          error={error}
          origin="onboarding"
        />
      </div>
    </main>
  );
}
