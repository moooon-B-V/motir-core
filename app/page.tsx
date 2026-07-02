import { redirect } from 'next/navigation';

// The motir-core root (Subtask 7.22.1 / MOTIR-1457 — the 8.3 entry rework).
//
// The marketing landing + hero prompt relocated OUT of motir-core to the
// standalone motir-marketing site (Story 8.3 / MOTIR-1152), so the root of the
// PM app is no longer a marketing page. It now lands the visitor on the login
// surface; the "Plan with AI" affordance there is the door into onboarding
// (`/onboarding`), and an idea typed on motir.co is preserved into onboarding via
// the cross-origin pre-auth draft receiver (MOTIR-1458, reusing the 1022 seam).
//
// The self-host "Connect Motir AI" gate that used to render here (behind
// `isAiPlanningConfigured()`) moved to the onboarding entrance
// (`app/(onboarding)/layout.tsx`): a self-hosted deployment with no Motir Cloud
// connection sees the deferred Connect gate when it reaches `/onboarding`, not at
// the root. Nothing here imports `motir-ai` (the open-core invariant).
export default function HomePage() {
  redirect('/sign-in');
}
