'use server';

import { redirect } from 'next/navigation';
import { clearPendingIdea, setPendingIdea } from '@/lib/onboarding/pendingIdea';

// The discovery onboarding's only Server Action (Subtask 7.3.5 / MOTIR-833):
// drop the preserved-idea cookie once it has been seeded as the first chat turn.
// The page READS the idea during render (`readPendingIdea`) to seed the loop, but
// a cookie can only be MUTATED in a Server Action / Route Handler — so the client
// fires this once on mount to complete the 7.3.14 → 7.3.5 seam (read + clear) and
// stop a stale idea from re-seeding a later visit.
export async function clearPendingIdeaAction(): Promise<void> {
  await clearPendingIdea();
}

// The onboarding ENTRANCE's Start-planning action (Subtask 7.22.4 / MOTIR-1462).
// The entrance form (`OnboardingEntrance`) posts the typed idea here; we persist
// it through the SAME preserved-idea cookie the discovery chat already reads to
// seed its first turn (`lib/onboarding/pendingIdea.ts`), then forward to the
// discovery route. Reusing that seam means the entrance needs no new prop
// plumbing — the idea flows entrance → cookie → discovery exactly as the
// motir.co-hero idea does. `setPendingIdea` trims + clamps and is a no-op for an
// empty idea, so "Start planning" with an empty box just opens the chat (which
// asks the first question) — the box is a head-start, not a gate.
export async function startPlanningAction(formData: FormData): Promise<void> {
  const idea = formData.get('idea');
  await setPendingIdea(typeof idea === 'string' ? idea : '');
  redirect('/onboarding/discovery');
}
