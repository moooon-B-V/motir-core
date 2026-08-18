import type { LinkedChangeRequestCompletionFact } from '@/lib/repositories/githubPullRequestRepository';

// PER-REPOSITORY DELIVERY (Story MOTIR-2725 · MOTIR-2415) — the ONE answer to
// "has this repository's work landed?", shared by the two consumers that must
// never disagree about it:
//
//   * `lib/services/changeRequestStatusSync.ts` — the completion gate, which
//     HOLDS an item at In Review while any repository it carries is unsatisfied.
//   * the work-item detail read — which RENDERS that same state per repository.
//
// They are the same question asked by a machine and by a person, and the story
// exists because a ledger nobody can see is a ledger nobody can correct. Two
// implementations would let the panel say `delivered` while the gate holds the
// card, which is the one bug this surface has no defence against — so the gate
// does not own a private copy: it calls this.

/**
 * What one repository on a work item's set has to show for itself.
 *
 * - `delivered` — a linked change request MERGED onto that repository's own
 *   default branch. The only state that satisfies the completion gate.
 * - `awaiting` — no such merge. Usually the pull request has not been opened
 *   yet, which is exactly the state `deferred_open_pr` cannot see (it counts
 *   rows, and an unopened PR has none).
 * - `unknown` — the repository HAS a merged linked change request and the mirror
 *   does not know which branch it merged into. Only rows written before
 *   `github_pull_request.base_ref` existed are in this state.
 */
export type RepoDeliveryState = 'delivered' | 'awaiting' | 'unknown';

/** One repository of an item's set, with its delivery state and its position. */
export interface RepoDelivery {
  /** The repository NAME, in the casing the item stored. */
  repo: string;
  state: RepoDeliveryState;
  /** Element 0 — the repository a dispatch routes to (ADR §2). */
  primary: boolean;
}

/**
 * Classify EVERY repository an item carries against the change requests linked
 * to it. Pure — the caller supplies both sides.
 *
 * Names are compared case-INSENSITIVELY: the expected side comes from the PIN
 * domain (a project's own repository set, which may name repositories that are
 * still plans) and the satisfied side from the installation mirror. They are
 * different tables, and a git host treats repository names case-insensitively.
 *
 * ⚠️ `unknown` is NOT a lenient `delivered`. A null `base_ref` must read as
 * UNKNOWN in BOTH directions — treating it as satisfied completes a card on a
 * possibly-STRANDED merge (MOTIR-1873: merged onto a sibling branch that was
 * then deleted, `merged: true` forever, no path to the trunk), and treating it
 * as outstanding asserts something false about a merge that may well have
 * landed. It holds the card, and the surface says which question to answer.
 */
export function classifyRepoDelivery(
  expected: readonly string[],
  linked: readonly LinkedChangeRequestCompletionFact[],
): RepoDelivery[] {
  return expected.map((repo, i) => {
    const key = repo.toLowerCase();
    const merged = linked.filter((f) => f.repoName.toLowerCase() === key && f.merged);
    const state: RepoDeliveryState = merged.some(
      (f) => f.baseRef !== null && f.baseRef === f.repoDefaultBranch,
    )
      ? 'delivered'
      : merged.some((f) => f.baseRef === null)
        ? 'unknown'
        : 'awaiting';
    return { repo, state, primary: i === 0 };
  });
}

/**
 * The completion gate's view of the same classification — the repositories that
 * do NOT satisfy it, split by which question a reader has to answer.
 *
 * Kept as its own export rather than left to each caller's `filter`, because the
 * gate's hold and the note it posts must be derived from one place: a gate that
 * held on `outstanding` while the note listed `unknownBase` would be two rules.
 */
export interface RepoSetShortfall {
  outstanding: string[];
  unknownBase: string[];
}

export const EMPTY_SHORTFALL: RepoSetShortfall = { outstanding: [], unknownBase: [] };

/** The shortfall of a classified set — empty when every repository is delivered,
 *  and empty for an EMPTY set, which is how the gate ABSTAINS on the common
 *  case (a card that names no repository behaves exactly as it does today). */
export function repoSetShortfall(delivery: readonly RepoDelivery[]): RepoSetShortfall {
  return {
    outstanding: delivery.filter((d) => d.state === 'awaiting').map((d) => d.repo),
    unknownBase: delivery.filter((d) => d.state === 'unknown').map((d) => d.repo),
  };
}

/** Whether a shortfall HOLDS the item — either list being non-empty. */
export function hasRepoSetShortfall(shortfall: RepoSetShortfall): boolean {
  return shortfall.outstanding.length > 0 || shortfall.unknownBase.length > 0;
}
