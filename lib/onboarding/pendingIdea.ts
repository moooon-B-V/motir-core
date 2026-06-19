import 'server-only';
import { cookies } from 'next/headers';

// ── The "preserved idea" seam (Subtask 7.3.14 → 7.3.5) ───────────────────────
//
// On the public front door (`app/page.tsx`), a LOGGED-OUT visitor types their
// idea into the hero prompt and submits. We must raise the `(auth)` flow without
// losing what they typed — they should never have to re-type it. We round-trip
// the idea through a short-lived cookie:
//
//   1. The hero submit (server action `submitIdeaAction`) writes the trimmed idea
//      to this cookie, then redirects into `(auth)` with `next=/onboarding`.
//   2. The cookie is `SameSite=Lax`, so it survives the top-level GET navigation
//      back from the auth flow — including the Google OAuth round-trip (Lax sends
//      the cookie on top-level navigations, which is exactly the post-OAuth
//      redirect).
//   3. After sign-in the user lands on the authed discovery chat (`/onboarding`,
//      owned by Subtask 7.3.5 / MOTIR-833). That surface calls `readPendingIdea()`
//      to seed the conversation's FIRST turn, then `clearPendingIdea()` so a stale
//      idea never leaks into a later session.
//
// This module is the CONTRACT between the two subtasks: 7.3.14 writes, 7.3.5
// reads + clears. It holds NO AI logic and imports nothing from `motir-ai` — the
// hero submit only ever reaches the planner through the 7.3.4 chat route, which
// 7.3.5 drives (the open-core invariant).

export const PENDING_IDEA_COOKIE = 'motir_pending_idea';

// Where the preserved idea lands after auth: the authed discovery chat (Subtask
// 7.3.5 / MOTIR-833). The front door redirects here (via `next=`) and 7.3.5 reads
// the cookie above to seed the conversation's first turn. Part of the same seam.
export const ONBOARDING_ENTRY_PATH = '/onboarding';

// Keep the cookie small and the seeded first turn sane. The hero textarea clamps
// to the same bound; anything longer is truncated rather than rejected, so a
// long paste still preserves the opening of the idea.
export const MAX_PENDING_IDEA_LENGTH = 2000;

// The cookie lives only long enough to cross the auth flow. Half an hour comfortably
// covers signing up (incl. email verification bounce) without lingering for days.
const PENDING_IDEA_TTL_SECONDS = 60 * 30;

/** Normalize a raw hero input into the value we persist (trim + clamp). */
export function normalizePendingIdea(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_PENDING_IDEA_LENGTH);
}

/** Persist the visitor's idea across the auth redirect. No-op for an empty idea. */
export async function setPendingIdea(idea: string): Promise<void> {
  const value = normalizePendingIdea(idea);
  if (!value) return;
  const store = await cookies();
  store.set(PENDING_IDEA_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: PENDING_IDEA_TTL_SECONDS,
  });
}

/** Read the preserved idea, if any (the 7.3.5 consumer entry point). */
export async function readPendingIdea(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(PENDING_IDEA_COOKIE)?.value;
  return value ? normalizePendingIdea(value) || null : null;
}

/** Drop the preserved idea once it has been seeded as the first turn. */
export async function clearPendingIdea(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_IDEA_COOKIE);
}
