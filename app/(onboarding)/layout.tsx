import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

// The onboarding route group's layout (Subtask 7.3.5 / MOTIR-833). Onboarding is
// an IMMERSIVE, FULL-SCREEN surface — the canvas roadmap (left) + the chat rail
// (right) own the whole viewport — so it deliberately sits OUTSIDE the `(authed)`
// group's `AppLayout` (top nav + project sidebar). It is still authenticated: we
// gate the session here (mirroring the authed layout's check) and bounce a
// signed-out visitor to /sign-in, but we render the page full-bleed with no app
// chrome around it.
export default async function OnboardingGroupLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  return children;
}
