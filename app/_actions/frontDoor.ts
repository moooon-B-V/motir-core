'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { ONBOARDING_ENTRY_PATH, setPendingIdea } from '@/lib/onboarding/pendingIdea';

// The hero-prompt submit on the public front door.
//
// This is the LOGIN GATE + idea-preservation behaviour (design Surface 2): a
// logged-out visitor's idea is preserved across the `(auth)` flow and carried into
// onboarding, so they never re-type it. The action ONLY stores the idea and
// routes — it never calls the planner itself (the hero reaches the planner only
// through the 7.3.4 chat route, which 7.3.5 drives — the open-core invariant).
export async function submitIdeaAction(formData: FormData): Promise<void> {
  const idea = formData.get('idea');
  await setPendingIdea(typeof idea === 'string' ? idea : '');

  const session = await getSession();
  if (!session) {
    // Logged out → raise the auth flow; `next` brings them back to onboarding,
    // where the preserved idea (the Lax cookie survives the redirect) is picked up.
    redirect(`/sign-up?next=${encodeURIComponent(ONBOARDING_ENTRY_PATH)}`);
  }
  // Already signed in → straight into onboarding with the idea preserved.
  redirect(ONBOARDING_ENTRY_PATH);
}
