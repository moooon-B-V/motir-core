import type { CodeContextDTO } from '@/lib/dto/codeContext';

// THE ONE THRESHOLD (Story MOTIR-1754 · MOTIR-4603) — "badly behind", defined
// once and read by every consumer that has to decide whether Motir can still
// trust its own view of the code.
//
// ⚠️ A THRESHOLD, NEVER "ANY DRIFT". With push-driven refresh healthy (a 2-minute
// debounce and a 15-minute cap) an active repository is ALWAYS a few commits
// behind between pushes. Pausing on any drift would pause the cadence
// permanently for exactly the projects doing the most work — the inverse of what
// it is for.
//
// ⚠️ DRIFT, NEVER AGE. A graph built three weeks ago on a repository nobody has
// pushed to is CURRENT; one built two hours ago on a repository that took three
// hundred commits is not. An age-led threshold gets both backwards.
//
// ⚠️ AND UNKNOWN IS NEVER "BADLY BEHIND". A repository whose drift cannot be
// counted answers `null`, and `null` must not pause anything: the same rule that
// makes a NULL head resolve to `current` rather than `stale` (MOTIR-1767). A
// pause on missing evidence is a false accusation that the user cannot even see
// the reason for.
export const BADLY_STALE_COMMITS_BEHIND = 50;

/**
 * Is this repo's graph BADLY behind — far enough that Motir should stop making
 * decisions on its own?
 *
 * ⚠️ UNREACHABLE IN PRODUCTION TODAY, and stated rather than left to be
 * discovered. `commitsBehind` is always `null` until its producer ships:
 * distinguishing `stale` from `current` needs only a sha inequality, while
 * COUNTING the commits between two shas needs a commit-graph read neither
 * repository holds. So the badly-stale arm is written, wired and tested from
 * constructed inputs — the day the count arrives it starts firing with nothing
 * here rewritten. This is MOTIR-4590's own pattern, one card over.
 */
export function isBadlyStale(repo: { commitsBehind: number | null }): boolean {
  if (repo.commitsBehind === null) return false;
  return repo.commitsBehind >= BADLY_STALE_COMMITS_BEHIND;
}

/** Why Motir should not decide to plan on its own right now. */
export type CodeBlindReason =
  /** No repository is connected to this project's workspace. */
  | 'no_connected_repo'
  /** At least one connected repo's graph is badly behind its default branch. */
  | 'badly_stale_graph';

/**
 * Should the AUTO cadence hold off? — `null` when it may proceed.
 *
 * ⚠️ AUTO-PLAN IS MOTIR DECIDING; CLICKING "PLAN WITH AI" IS THE USER DECIDING.
 * This function answers only the first. Withholding Motir's own judgment while
 * leaving the user's alone is the whole distinction between consent and a block,
 * and nothing here may be reached from a manual path.
 *
 * ⚠️ A FRESHNESS READ THAT DID NOT ANSWER DOES NOT PAUSE. `freshnessUnknown`
 * means motir-ai could not be asked, which is not evidence of drift. Pausing the
 * cadence on an AI-side outage would convert one service's downtime into a
 * silent, unexplained stop on every project that has a repository.
 */
export function codeBlindPauseReason(context: CodeContextDTO): CodeBlindReason | null {
  if (!context.hasCodeContext) return 'no_connected_repo';
  if (context.freshnessUnavailable) return null;
  return context.repos.some(isBadlyStale) ? 'badly_stale_graph' : null;
}
