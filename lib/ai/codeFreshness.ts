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
// counted answers `null`, and `null` must not pause anything — the same rule that
// makes a NULL head sha resolve to `indexed` rather than `stale`
// (`lib/codeGraph/indexState.ts`). A pause on missing evidence is a false
// accusation the user cannot even see the reason for.
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
 * ⚠️ THE "FRESHNESS UNAVAILABLE" GUARD IS GONE, AND ITS REASONING IS WHY.
 * It existed because freshness came from motir-ai across the 7.1 boundary, and a
 * read that could not be made is not evidence of drift — pausing on it would
 * convert one service's downtime into a silent stop on every project with a
 * repository. MOTIR-4724 moved every fact the state is derived from into
 * motir-core's own columns, so there is no longer a read that can fail to answer:
 * the condition is not merely unreachable, it is inexpressible. Deleted rather
 * than left as a branch nothing can enter.
 */
export function codeBlindPauseReason(context: CodeContextDTO): CodeBlindReason | null {
  if (!context.hasCodeContext) return 'no_connected_repo';
  return context.repos.some(isBadlyStale) ? 'badly_stale_graph' : null;
}
