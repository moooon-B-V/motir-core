import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { MotirAiError } from '@/lib/ai/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { isDirectionDocKind } from '@/lib/onboarding/directionDoc';
import { findTierDoc, producedTierKinds } from '@/lib/onboarding/preplanClient';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import { DirectionDocFullPage } from './_components/DirectionDocFullPage';

// GET /direction/[tier] (Subtask 7.20.14 / MOTIR-1355) — the read-only FULL PAGE
// for one pre-plan direction-tier doc, reached from the tier-doc modal's
// "Open full page" (design/roadmap/detail-surfaces panel 5). Renders the SHIPPED
// `DirectionDocView` (834) at full reading width in the app shell — never a redraw.
//
// Active-project routing (the project comes from the workspace+active-project
// context, never a URL key — every other authed route is the same; the design's
// `/projects/[key]/direction/[tier]` URL is adapted to the shipped routing model).
// The pre-plan read goes through `aiPreplanService` server-side; a motir-ai
// upstream failure renders the error state rather than crashing the page.

export default async function DirectionDocPage({ params }: { params: Promise<{ tier: string }> }) {
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
    // A motir-ai upstream failure is shown as the error state (the dependency
    // failed, not the request); anything else is a real bug — let it surface.
    if (err instanceof MotirAiError) error = true;
    else throw err;
  }

  return (
    <DirectionDocFullPage
      tier={tier}
      doc={state ? findTierDoc(state, tier) : null}
      catalog={state?.catalog ?? null}
      availableDocs={state ? producedTierKinds(state) : []}
      error={error}
    />
  );
}
