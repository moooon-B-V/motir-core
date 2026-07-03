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
//      (`preplanClient.fetchPreplanState`): a live pre-plan `session` exists and
//      has not reached the terminal `tiers_complete` status.
//
// Both must hold. Keeping them pure (no React, no fetch) is what lets the
// shown/hidden logic be unit-tested without a DOM or a network stub.

/** The tier-completion status a finished discovery session carries (see
 *  `lib/onboarding/discoveryLoop.ts`); a session at this status is done, not
 *  resumable. */
export const PREPLAN_STATUS_COMPLETE = 'tiers_complete';

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
 * The client signal — true when the pre-plan state carries a live session that
 * has not finished the discovery tiers. A `null` state (fetch failed / AI down)
 * or a `null` session (a project that never started onboarding) is NOT in
 * progress; neither is a session already at `tiers_complete`.
 */
export function isPreplanInProgress(state: PreplanStateDTO | null | undefined): boolean {
  const session = state?.session ?? null;
  if (!session) return false;
  return session.status !== PREPLAN_STATUS_COMPLETE;
}
