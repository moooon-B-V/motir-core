'use server';

import { clearPendingIdea } from '@/lib/onboarding/pendingIdea';

// The discovery onboarding's only Server Action (Subtask 7.3.5 / MOTIR-833):
// drop the preserved-idea cookie once it has been seeded as the first chat turn.
// The page READS the idea during render (`readPendingIdea`) to seed the loop, but
// a cookie can only be MUTATED in a Server Action / Route Handler — so the client
// fires this once on mount to complete the 7.3.14 → 7.3.5 seam (read + clear) and
// stop a stale idea from re-seeding a later visit.
export async function clearPendingIdeaAction(): Promise<void> {
  await clearPendingIdea();
}
