import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// The "Resume onboarding" re-entry door (MOTIR-1533; design MOTIR-1548) is shown
// only when the active project has an IN-PROGRESS, un-finished onboarding. That
// decomposes into two independently-testable predicates that split cleanly along
// the server↔client boundary:
//
//   1. `resumeGateEnabled` — the SERVER-cheap gate resolved in the (authed)
//      layout from data already in hand: AI planning is wired, there IS an active
//      project, and its onboarding never finished (`onboardingRanAt` is still
//      null — a set value means the first plan already materialised, at which
//      point both onboarding pages redirect away, so there is nothing to resume).
//   2. `isPreplanInProgress` — the CLIENT signal, read from `GET /api/ai/pre-plan`
//      (`preplanClient.fetchPreplanState`): a live pre-plan `session` exists.
//
// Both must hold. Keeping them pure (no React, no fetch) is what lets the
// shown/hidden logic be unit-tested without a DOM or a network stub.

/**
 * Where the door RESUMES to — the discovery surface (`DiscoveryOnboarding`),
 * which rehydrates the persisted session and lands on the real step (MOTIR-1487).
 * NOT `/onboarding`: that route is the entrance FORK (the idea box + import,
 * MOTIR-1462), and it deliberately does no AI read (open-core invariant), so it
 * can't tell an in-progress project from a new one — it just shows the idea
 * input. The resume door skips the fork and goes straight to the surface that
 * actually resumes. (Bug MOTIR-1556: the door originally pointed at `/onboarding`
 * and dropped the user on the idea box.)
 */
export const ONBOARDING_RESUME_PATH = '/onboarding/discovery';

/**
 * The server-cheap gate for the resume door — computed in `app/(authed)/layout.tsx`
 * from the already-resolved `activeProject` + `isMotirAiConfigured()`. Returns
 * false (so the client never even fetches the pre-plan state) unless AI planning
 * is configured, a project is active, and that project's onboarding has not yet
 * finished.
 */
export function resumeGateEnabled(args: {
  aiPlanningConfigured: boolean;
  hasActiveProject: boolean;
  /** The active project's `onboardingRanAt` (ISO string when finished, else null). */
  onboardingRanAt: string | null | undefined;
}): boolean {
  return Boolean(
    args.aiPlanningConfigured && args.hasActiveProject && args.onboardingRanAt == null,
  );
}

/**
 * The client signal — true when the pre-plan state carries a live session. Any
 * existing session on a project whose `onboardingRanAt` is still null (the
 * `resumeGateEnabled` half) is un-finished, resumable onboarding — INCLUDING a
 * session at `tiers_complete` (the discovery tiers are done, but the plan hasn't
 * materialised yet, so onboarding continues and the door must still show; bug
 * MOTIR-1556 hid it). Only a `null` state (fetch failed / AI down) or a `null`
 * session (a project that never started onboarding) is not in progress. The
 * terminal case — a materialised plan — is already excluded by the server gate
 * (`onboardingRanAt` set), so it never reaches here.
 */
export function isPreplanInProgress(state: PreplanStateDTO | null | undefined): boolean {
  return (state?.session ?? null) !== null;
}
