import type { LinkedChangeRequestCompletionFact } from '@/lib/repositories/githubPullRequestRepository';
import { repoNameKey } from './repoName';

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
export type RepoDeliveryState =
  | 'delivered'
  | 'awaiting'
  | 'unknown'
  /**
   * The repository DOES NOT EXIST YET — the row is `proposed`, `creating` or
   * `failed` (Story MOTIR-2732 · MOTIR-3042, ADR "Amendment 2026-08-18" §A5).
   *
   * ⚠️ Deliberately NOT `awaiting`, and the difference is the reader's next
   * action, not a shade of meaning. `awaiting` says a pull request has not been
   * opened and points at the host; `unestablished` says there is no repository to
   * open one against and points at the project's establish step. Collapsing them
   * is what produced the false "No pull request yet" row MOTIR-3036 fixed, one
   * level down. It HOLDS the item: the work plainly has not shipped.
   */
  | 'unestablished'
  /**
   * The row was SKIPPED — the project is deliberately code-less there
   * (`project-repository-set.md` §4.3).
   *
   * One of the two states that do NOT hold the item. Holding it would make §4.3
   * unreachable: a card would wait forever for work the user explicitly
   * declined.
   */
  | 'excluded'
  /**
   * The repository's work FINISHED WITHOUT A CHANGE REQUEST (MOTIR-7180) — a
   * container's leaf cards that target it are all in a done-category status and
   * none of them carries a linked delivery, and the container itself has no
   * linked change request there either. A release cut by pushing a tag, a
   * package published by hand, a dashboard setting: a human or manual card
   * ships these, and nothing will ever merge for them.
   *
   * The other state that does NOT hold the item. Holding on it made the gate
   * unsatisfiable by construction — every later merge re-held the container,
   * and the only way out was a person moving the status by hand.
   *
   * ⚠️ NOT "a Done child excuses a missing merge". It is reached only from
   * `awaiting`, only on evidence the caller computed from the leaves
   * (`ExpectedRepo.shippedWithoutChangeRequest`), and only when the item has no
   * linked change request in that repository at all — so an open, unmerged,
   * closed or merged-elsewhere pull request keeps the state it had.
   */
  | 'delivered_without_change_request';

/** One repository of an item's set, with its delivery state and its position. */
export interface RepoDelivery {
  /** The repository NAME, in the casing the item stored. */
  repo: string;
  state: RepoDeliveryState;
  /** Element 0 — the repository a dispatch routes to (ADR §2). */
  primary: boolean;
  /** WHAT the repository is (`web` · `api` · …) — carried only when the item
   *  points at a `project_repository` ROW, because the role is that row's
   *  property and a bare name string has none. Optional for exactly that
   *  reason: the compatibility rung (ADR §5) has a name and no row. */
  role?: string | undefined;
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
/**
 * One expected repository, as the classifier now receives it (MOTIR-3042).
 *
 * `establishState` is what lets the four rows a NAME could never tell apart —
 * exists / not created yet / declined — be told apart. `undefined` means the
 * caller has only a name (a project with no repository set, §A7's compatibility
 * rung), and the classifier then behaves exactly as it did before this field
 * existed.
 */
export interface ExpectedRepo {
  repo: string;
  establishState?: string | undefined;
  /** The row's role, carried straight through to the panel — see `RepoDelivery.role`. */
  role?: string | undefined;
  /**
   * The item is a CONTAINER whose live leaf cards targeting this repository are
   * ALL in a done-category status, there is at least one, and none of them has
   * a linked delivery (MOTIR-7180) — computed by `resolveExpectedRepos` from the
   * tree, because the classifier sees only the item's own change requests.
   * `undefined` reads as `false`.
   */
  shippedWithoutChangeRequest?: boolean | undefined;
}

/** The row states in which a repository DOES NOT EXIST on the host yet. */
const UNESTABLISHED_STATES = new Set(['proposed', 'creating', 'failed']);

export function classifyRepoDelivery(
  expected: readonly (string | ExpectedRepo)[],
  linked: readonly LinkedChangeRequestCompletionFact[],
): RepoDelivery[] {
  return expected.map((entry, i) => {
    const { repo, establishState, role, shippedWithoutChangeRequest } =
      typeof entry === 'string'
        ? {
            repo: entry,
            establishState: undefined,
            role: undefined,
            shippedWithoutChangeRequest: undefined,
          }
        : entry;
    // The row's own state decides FIRST, because it decides whether a pull
    // request could exist at all. Asking about merges for a repository that has
    // not been created is asking the wrong question, however the answer comes
    // out.
    if (establishState === 'skipped')
      return { repo, role, state: 'excluded' as const, primary: i === 0 };
    if (establishState !== undefined && UNESTABLISHED_STATES.has(establishState)) {
      return { repo, role, state: 'unestablished' as const, primary: i === 0 };
    }
    const key = repo.toLowerCase();
    const inRepo = linked.filter((f) => f.repoName.toLowerCase() === key);
    const merged = inRepo.filter((f) => f.merged);
    const state: RepoDeliveryState = merged.some(
      (f) => f.baseRef !== null && f.baseRef === f.repoDefaultBranch,
    )
      ? 'delivered'
      : merged.some((f) => f.baseRef === null)
        ? 'unknown'
        : // MOTIR-7180 — only from `awaiting`, and only with NO linked change
          // request in this repository at all: one that exists, in any state,
          // is the question this state must not answer for it.
          shippedWithoutChangeRequest === true && inRepo.length === 0
          ? 'delivered_without_change_request'
          : 'awaiting';
    return { repo, role, state, primary: i === 0 };
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
  /** Repositories that do not EXIST yet (§A5). Holds, like the other two —
   *  `excluded` appears in NO list, which is how it abstains. */
  unestablished: string[];
}

export const EMPTY_SHORTFALL: RepoSetShortfall = {
  outstanding: [],
  unknownBase: [],
  unestablished: [],
};

/** The shortfall of a classified set — empty when every repository is delivered,
 *  and empty for an EMPTY set, which is how the gate ABSTAINS on the common
 *  case (a card that names no repository behaves exactly as it does today). */
export function repoSetShortfall(delivery: readonly RepoDelivery[]): RepoSetShortfall {
  return {
    outstanding: delivery.filter((d) => d.state === 'awaiting').map((d) => d.repo),
    unknownBase: delivery.filter((d) => d.state === 'unknown').map((d) => d.repo),
    // §A5: a repository that does not exist yet HOLDS the item — the work
    // plainly has not shipped — but it is its own list, because the note the
    // hold posts must send the reader to the establish step and not to GitHub.
    unestablished: delivery.filter((d) => d.state === 'unestablished').map((d) => d.repo),
  };
}

/** Whether a shortfall HOLDS the item — either list being non-empty. */
export function hasRepoSetShortfall(shortfall: RepoSetShortfall): boolean {
  return (
    shortfall.outstanding.length > 0 ||
    shortfall.unknownBase.length > 0 ||
    shortfall.unestablished.length > 0
  );
}

/**
 * The repositories the Development section draws a PLACEHOLDER row for — the
 * item's set, minus every repository that already has a row of its own.
 *
 * ⚠️ **Delivery state and "has a pull request" are DIFFERENT QUESTIONS, and the
 * section needs the second one** (MOTIR-3036). `awaiting` means *not merged onto
 * the default branch* — correct for the completion gate, and true for the entire
 * life of every open pull request. Read as *"no pull request exists"* it produced
 * a row asserting "No pull request yet" directly beneath the pull request it was
 * asserting it about. So the placeholder keys on the pull request EXISTING,
 * whatever its state: an open one, a merged-onto-a-side-branch one and a closed
 * one all render their own row, and a repository with any of them is not owed a
 * placeholder.
 *
 * It lives HERE, next to the classifier, and the component calls it — rather
 * than each of the two hosts filtering its own list before mounting the shared
 * body. That per-caller filter is what let the detail page and the quick view
 * disagree, and it would let them disagree again one fix later.
 *
 * `delivered` is still dropped, for the reason it always was: a merged
 * repository is finished, and the section has its pull-request row to show for
 * it. That drop moved in here WITH the cross-reference, so a host passes the
 * item's set verbatim and makes no editorial decision at all.
 */
export function awaitingRepoRows(
  delivery: readonly RepoDelivery[],
  pullRequests: readonly { repo: string }[],
): RepoDelivery[] {
  // Compared on the shared repository IDENTITY, not on the raw strings: the two
  // sides are written by different tables in different forms (`motir-core` from
  // the item's pin, `moooon-B-V/motir-core` from the PR DTO), and comparing them
  // as-is matches nothing at all — which is the defect, not a hardening of it.
  const linked = new Set<string>();
  for (const pr of pullRequests) {
    const key = repoNameKey(pr.repo);
    if (key !== null) linked.add(key);
  }
  return delivery.filter((d) => {
    if (d.state === 'delivered') return false;
    const key = repoNameKey(d.repo);
    // A set entry that names no repository at all cannot be matched by a pull
    // request, so it keeps its row rather than silently disappearing.
    return key === null || !linked.has(key);
  });
}
