import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { isAiPlanningConfigured } from '@/lib/ai/planningConfig';
import { ConnectAiGate } from '@/app/_components/ConnectAiGate';
import { ONBOARDING_ENTRY_PATH } from '@/lib/onboarding/pendingIdea';

// The onboarding route group's layout (Subtask 7.3.5 / MOTIR-833). Onboarding is
// an IMMERSIVE, FULL-SCREEN surface — the canvas roadmap (left) + the chat rail
// (right) own the whole viewport — so it deliberately sits OUTSIDE the `(authed)`
// group's `AppLayout` (top nav + project sidebar). It is still authenticated: we
// gate the session here (mirroring the authed layout's check) and bounce a
// signed-out visitor to /sign-in, but we render the page full-bleed with no app
// chrome around it.
//
// Self-host deferred Connect gate (Subtask 7.22.1 / MOTIR-1457). Onboarding is
// entirely AI-driven, so a self-hosted deployment with no Motir Cloud connection
// has nothing to onboard into — it should see a "Connect Motir AI" gate instead
// of the discovery chat (the gate relocated here from the old root front door).
//
// Building the actual self-host connect flow is DEFERRED (a separate self-host
// story); this is the flagged PLACEHOLDER. It is gated on its OWN opt-in env flag
// (`MOTIR_SELFHOST_CONNECT_GATE`), DEFAULT OFF, and DELIBERATELY not on the shared
// `MOTIR_AI_URL`/`isMotirAiConfigured()` env: that pair also drives the authed
// shell's Plan-with-AI affordances (the TopNav entry + the bottom-right FAB), so
// keying the gate off it would couple this placeholder to unrelated shell UI. Off
// by default, cloud and current deployments reach discovery untouched; a self-host
// opts in to surface the deferred gate (and only when AI truly isn't wired up, so
// a self-host that HAS connected still reaches discovery). The check runs BEFORE
// the session gate so a self-hoster isn't forced to sign in only to be told AI
// planning isn't available. Nothing here imports `motir-ai` (the open-core
// invariant).
export default async function OnboardingGroupLayout({ children }: { children: ReactNode }) {
  if (process.env['MOTIR_SELFHOST_CONNECT_GATE'] === '1' && !isAiPlanningConfigured()) {
    return <ConnectAiGate />;
  }

  const session = await getSession();
  // Preserve the onboarding intent across auth: a logged-out visitor who followed
  // the "Plan with AI" door (or hit /onboarding directly) is bounced to sign-in
  // with `next=/onboarding`, so after signing in they land back in onboarding
  // rather than the default dashboard. The sign-in form honors `?next`.
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(ONBOARDING_ENTRY_PATH)}`);
  return children;
}
