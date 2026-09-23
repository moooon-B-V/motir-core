/**
 * How long a planning session stays RESUMABLE after its last turn —
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 17 §3 (story MOTIR-6011).
 *
 * Opening the planning surface for a scope resumes the member's OWN most recent
 * session for that scope only if its `lastActivityAt` falls inside this window;
 * otherwise the next first turn starts a new session. Two hours is longer than a
 * working interruption (a meeting, a review, lunch) and shorter than a day's
 * context switch: a conversation left overnight is about yesterday's intent, and
 * resuming it silently is what the story exists to stop.
 *
 * ONE named constant, so changing the window is one edit.
 */
export const PLAN_SESSION_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The earliest `lastActivityAt` a session may carry and still be resumed at `now`. */
export function resumableSince(now: Date): Date {
  return new Date(now.getTime() - PLAN_SESSION_RESUME_WINDOW_MS);
}
