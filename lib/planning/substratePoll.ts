import type { OnboardingSubstrate } from '@/lib/dto/onboardingSubstrate';

// THE WAIT'S OWN INSTRUMENT (Story MOTIR-4753 · MOTIR-4829) — ask the server
// whether the repository the window is waiting on has finished indexing.
//
// ⚠️ A POLL, AND THE CHOICE IS EXPLAINED RATHER THAN DEFAULTED. The plan window
// is a `'use client'` island seeded from server props in a `useState`
// initializer, so `router.refresh()` re-runs the server read and the island
// never sees it (`CLAUDE.md` § page state after a mutation, case 3). The two
// instruments that DO reach an island are a provider TICK and a refetch, and a
// tick needs something in this browser to bump it — the event this waits on
// happens in a background job on another machine. So the island asks.
//
// ⚠️ EVERY FAILURE IS A CONTINUE, NEVER A CONCLUSION. A dead request, a 404, a
// body that does not parse: none of those is evidence the index finished or
// failed, so the poll simply tries again on its next tick. The surface it feeds
// already says the wait continues, which is the truthful thing to keep saying.

/** How often to ask. */
export const SUBSTRATE_POLL_INTERVAL_MS = 5_000;

/**
 * How long to keep asking before the surface stops promising.
 *
 * ⚠️ IT IS A CEILING ON THE PROMISE, NOT ON THE INDEX. The job keeps running
 * whatever this says; what expires is the window's claim that it is about to
 * finish, because a spinner that has been spinning for ten minutes has stopped
 * being information. The surface says so rather than going quiet.
 */
export const SUBSTRATE_POLL_CEILING_MS = 10 * 60_000;

export async function fetchPlanningSubstrate(
  opts: { signal?: AbortSignal } = {},
): Promise<OnboardingSubstrate | null> {
  try {
    const res = await fetch('/api/planning/substrate', {
      method: 'GET',
      cache: 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return null;
    const s = body as Partial<OnboardingSubstrate>;
    if (!Array.isArray(s.repositories) || typeof s.itemCount !== 'number') return null;
    return body as OnboardingSubstrate;
  } catch {
    return null;
  }
}

/**
 * HAS THE THING THE WINDOW IS WAITING FOR HAPPENED?
 *
 * ⚠️ ANY repository being indexed ends the wait, matching
 * `readOnboardingSubstrate`'s own `repositoryIndexed` derivation — one readable
 * repository is enough for the verdict to be asked again, and asking it is what
 * decides whether that is ENOUGH. This function answers a question of fact and
 * makes no judgement, exactly as the read it mirrors does.
 */
export function anyRepositoryIndexed(substrate: OnboardingSubstrate | null): boolean {
  return substrate !== null && substrate.repositories.some((repo) => repo.indexed);
}
