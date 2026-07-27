import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { PLANNING_WORKSPACE_PATH } from '@/lib/planning/launcher';

// The planning route group's layout (Subtask MOTIR-1729). The universal planning
// workspace is the canvas (left) + chat rail (right) owning the WHOLE viewport,
// so — exactly like the `(onboarding)` group — it sits OUTSIDE the `(authed)`
// group's `AppLayout` (top nav + project sidebar) and renders full-bleed with no
// app chrome. The workspace carries its own exit chrome instead (the Close
// control + `Esc`, design `plan-change-conversation.mock.html` panel 2).
//
// It is still authenticated: the session gate mirrors the authed layout's, and a
// signed-out visitor who followed the "Plan with AI" door is bounced to sign-in
// with `next=/planning`, so they land back in the workspace after signing in
// (the sign-in form honors `?next`) rather than the default dashboard.
//
// Nothing here imports `motir-ai` — the open-core invariant. Whether the AI
// planning capability is wired at all gates the LAUNCHER's mount
// (`(authed)/layout.tsx` → `isMotirAiConfigured()`), not this route.
export default async function PlanningGroupLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(PLANNING_WORKSPACE_PATH)}`);
  return children;
}
