import { ConnectAiGate } from '@/app/_components/ConnectAiGate';
import { PublicFrontDoor } from '@/app/_components/PublicFrontDoor';
import { isAiPlanningConfigured } from '@/lib/ai/planningConfig';

// The public front door (Subtask 7.3.14 — the root a brand-new visitor lands on,
// the *vibe project* framing). Replaces the placeholder root page.
//
//   - **Cloud / connected** (AI planning configured) → the marketing landing +
//     hero prompt (`PublicFrontDoor`, design Surfaces 1 + 2).
//   - **Self-hosted, not connected** → the "Connect Motir AI" gate
//     (`ConnectAiGate`, design Surface 6) — the hero would be useless without a
//     planner to talk to (the cloud-gated-AI decision).
//
// The decision is read server-side from the deployment's env (no client flag, no
// `motir-ai` import — the open-core boundary).
export default function HomePage() {
  if (!isAiPlanningConfigured()) {
    return <ConnectAiGate />;
  }
  return <PublicFrontDoor />;
}
