import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import type { RepoDelivery, RepoDeliveryState } from './repoDelivery';
import { repoNameKey } from './repoName';

/**
 * The DELIVERY SET's shortfall — which of a card's deliveries have not landed
 * (Story MOTIR-3655 · MOTIR-3659, ADR `docs/decisions/work-item-delivery-links.md`).
 *
 * ── What this answers, and why it is not the repository-set gate ───────────
 * `deferred_incomplete_repo_set` asks *"has every repository this card CARRIES
 * seen a merge?"* — a declaration about work that was PROMISED, which can hold a
 * card for a repository whose pull request was never opened at all. This asks
 * *"has every pull request that DELIVERS this card merged?"* — evidence about
 * work that HAPPENED. The two are kept apart on purpose: a card can satisfy
 * either without the other, and collapsing them loses the distinction in the
 * direction that closes a card early.
 *
 * ── The comparison is PER REPOSITORY, deliberately ────────────────────────
 * A member is landed when its pull request is merged **onto its own
 * repository's default branch**. Never a hard-coded `'main'`: a self-hoster's
 * trunk is `master` or `trunk`, and a card spanning two repositories may face
 * two different names. `repoId` is on the delivery row precisely so this
 * comparison costs no join per member.
 *
 * Pure — no Prisma client, no database — so the gate's hold and the note it
 * posts are both derived from one function rather than two filters that can
 * drift apart.
 */

/** One delivery, in the minimal shape this reasons over. */
export interface DeliveryMember {
  /** `owner/name`, for the note a held card carries. */
  repoLabel: string;
  /** The pull request's number, so the reader can go and look at it. */
  number: number;
  merged: boolean;
  /** The branch the pull request TARGETS — null on a row mirrored before Motir
   *  recorded base branches. */
  baseRef: string | null;
  /** That repository's OWN default branch. */
  defaultBranch: string;
}

export interface DeliverySetShortfall {
  /** Members that have not merged at all — the ordinary "still open" case. */
  outstanding: string[];
  /** Members merged onto a base that is NOT their repository's default branch —
   *  a stranded merge, which delivers nothing to the trunk. Its own list because
   *  the note must send the reader to the base that swallowed it. */
  strandedBase: string[];
  /** Members whose base branch was never recorded, so whether the work reached
   *  the trunk cannot be told. Holds, like the other two, and its own list
   *  because the remedy is an operator backfill rather than a merge. */
  unknownBase: string[];
}

export const EMPTY_DELIVERY_SHORTFALL: DeliverySetShortfall = {
  outstanding: [],
  strandedBase: [],
  unknownBase: [],
};

function label(m: DeliveryMember): string {
  return `${m.repoLabel}#${m.number}`;
}

/**
 * The shortfall of a card's delivery set.
 *
 * **Empty for an EMPTY set, which is how the gate ABSTAINS on the common case.**
 * Almost every card in the tree has zero or one delivery, and a card with none
 * behaves exactly as it does today — that is the property this whole story must
 * not perturb, and it falls out of the empty list rather than a special case.
 */
export function deliverySetShortfall(members: readonly DeliveryMember[]): DeliverySetShortfall {
  const outstanding: string[] = [];
  const strandedBase: string[] = [];
  const unknownBase: string[] = [];

  for (const m of members) {
    if (!m.merged) {
      outstanding.push(label(m));
      continue;
    }
    if (m.baseRef === null) {
      unknownBase.push(label(m));
      continue;
    }
    if (m.baseRef !== m.defaultBranch) {
      strandedBase.push(label(m));
    }
  }

  return { outstanding, strandedBase, unknownBase };
}

/** Whether a shortfall HOLDS the card — any list being non-empty. */
export function hasDeliverySetShortfall(shortfall: DeliverySetShortfall): boolean {
  return (
    shortfall.outstanding.length > 0 ||
    shortfall.strandedBase.length > 0 ||
    shortfall.unknownBase.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The RAIL's amended predicate (Story MOTIR-3655 · MOTIR-3660)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AMEND a classified repository set with what the DELIVERY SET knows
 * (design `design/work-items/delivery-set.mock.html`, CHANGE 1).
 *
 * ── The bug this closes, stated exactly ───────────────────────────────────
 * `classifyRepoDelivery` calls a repository `delivered` when **any** linked pull
 * request merged onto its default branch. That is the right answer to
 * `deferred_incomplete_repo_set`'s question — *has this repository seen a
 * merge?* — and the WRONG answer for a reader, because a card with two pull
 * requests in ONE repository, one merged and one open, then reads `Delivered`
 * while `deferred_incomplete_delivery_set` is holding it. The rail would assert
 * finished about a card the gate is refusing to finish, which is the failure
 * MOTIR-3655 was filed about, one layer up.
 *
 * So a row is `delivered` only when NEITHER gate holds on it: the repository has
 * seen a merge AND every delivery recorded in that repository has landed on that
 * repository's own default branch. The two gates keep their separate questions —
 * they are not collapsed here, and neither reads this — and the glyph mirrors
 * their CONJUNCTION, which is what a reader actually wants to know.
 *
 * ── What it never does ────────────────────────────────────────────────────
 * **It only ever weakens a row.** A repository the classifier called `awaiting`
 * or `unestablished` is never promoted by a delivery, because a delivery is
 * evidence about a pull request and those two states are claims about the
 * repository. And a card with an EMPTY delivery set — nearly every card in the
 * tree — comes back byte-identical, which is the property the whole story must
 * not perturb and is why the empty case is the first line.
 *
 * Pure, and it lives beside the shortfall it agrees with rather than in the
 * component, so the peek and the detail page cannot each grow their own version
 * of it — the drift `repoDelivery.ts`'s own header was written about.
 */
export function amendRepoDeliveryWithSet(
  repos: readonly RepoDelivery[],
  deliveries: readonly WorkItemDeliveryDto[],
): RepoDelivery[] {
  if (deliveries.length === 0) return [...repos];

  // Grouped on the shared repository IDENTITY: the two sides are written by
  // different tables in different forms (`motir-core` from the card's pin,
  // `moooon-B-V/motir-core` from the pull request), and comparing the raw
  // strings matches nothing at all — the defect `awaitingRepoRows` documents.
  const byRepo = new Map<string, WorkItemDeliveryDto[]>();
  for (const delivery of deliveries) {
    const key = repoNameKey(delivery.pullRequest.repo);
    if (key === null) continue;
    const bucket = byRepo.get(key);
    if (bucket) bucket.push(delivery);
    else byRepo.set(key, [delivery]);
  }

  return repos.map((row) => {
    if (row.state !== 'delivered') return row;
    const key = repoNameKey(row.repo);
    const mine = key === null ? undefined : byRepo.get(key);
    if (mine === undefined || mine.length === 0) return row;

    const shortfall = deliverySetShortfall(
      mine.map((d) => ({
        repoLabel: d.pullRequest.repo,
        number: d.pullRequest.number,
        merged: d.pullRequest.state === 'merged',
        baseRef: d.baseRef,
        defaultBranch: d.defaultBranch,
      })),
    );
    if (!hasDeliverySetShortfall(shortfall)) return row;

    // WHICH weaker state, and the order matters: an unrecorded base is a
    // question the reader has to answer (`unknown`, the warning glyph), while an
    // open or stranded delivery is work that has not arrived (`awaiting`, the
    // dashed one). A row with both is `unknown`, because that is the one that
    // asks for an action rather than for patience.
    const state: RepoDeliveryState = shortfall.unknownBase.length > 0 ? 'unknown' : 'awaiting';
    return { ...row, state };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The PROMOTION's predicate (Story MOTIR-3655 · MOTIR-3685)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a card's whole delivery set GREEN — the question `implemented → in_review`
 * turns on (design decision recorded on MOTIR-3685, 2026-08-27).
 *
 * ── What changed, and why it is a change rather than an addition ───────────
 * `ciPromotion` shipped promoting *every card the pull request delivers* the
 * moment THAT pull request went green. Correct while a card had exactly one
 * pull request, and wrong the first time it has two: a card delivered by
 * `motir-core#1` (green) and `motir-ai#2` (red) was announced reviewable on half
 * its evidence. **One green and one red leaves the card at `implemented`.**
 *
 * ── Two properties, and the second is the one that is easy to lose ────────
 *   1. EVERY member must be `passing`. A `running` member is not a failure and
 *      not a pass — the loop is waiting for a verdict, not receiving one — so it
 *      withholds exactly as a red one does.
 *   2. **An EMPTY set is NOT green.** `[].every(...)` is vacuously true, and a
 *      card with no pull request at all would promote itself to In Review on no
 *      evidence whatever. Absence of CI is not a state (`derivePrCiState` returns
 *      null for it) and it is certainly not a pass.
 *
 * A card with exactly ONE pull request gets the same answer it always did:
 * over a set of one, "every" and "some" agree. That is what makes this safe for
 * the overwhelming majority of cards, and it is asserted rather than assumed.
 */
export function deliverySetIsGreen(states: readonly (string | null)[]): boolean {
  if (states.length === 0) return false;
  return states.every((state) => state === 'passing');
}
