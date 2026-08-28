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
 *      evidence whatever. A card with no pull request has no evidence, and no
 *      evidence is not a pass.
 *
 * ⚠️ A `null` MEMBER IS NOT ALWAYS "NOT PASSING" ANY MORE (MOTIR-3823). This
 * function still reads exactly what it is handed — `passing` or nothing — but the
 * PROMOTION now maps each member through `deliveryStateForPromotion` first, which
 * turns the `null` of a repository that CANNOT report a check into `passing`. The
 * empty-set rule above is untouched by that and is the one property this file
 * must never lose: a card with no delivery at all still has nothing to map.
 *
 * A card with exactly ONE pull request gets the same answer it always did:
 * over a set of one, "every" and "some" agree. That is what makes this safe for
 * the overwhelming majority of cards, and it is asserted rather than assumed.
 */
export function deliverySetIsGreen(states: readonly (string | null)[]): boolean {
  if (states.length === 0) return false;
  return states.every((state) => state === 'passing');
}

// ─────────────────────────────────────────────────────────────────────────────
// A REPOSITORY THAT CANNOT REPORT A CHECK (MOTIR-3823)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `derivePrCiState` answers `null` for a pull request with no check rows, and it
 * is right to: absence of CI is not a state, and the Development pill renders
 * nothing for it. **But `deliverySetIsGreen` reads that `null` as "not passing",
 * which is only correct for ONE of the two situations that produce it:**
 *
 *   1. the repository has **no CI at all** — nothing will ever report; and
 *   2. **nothing has reported YET** — a pull request opened seconds ago, a
 *      webhook still in flight, a run that has not started.
 *
 * Decided by Yue, 2026-08-28: **(1) counts as GREEN.** A repository is allowed
 * to have no CI — `motir-meta` is this project's own instance and carries the
 * planning corpus — and holding its cards at `implemented` for ever punishes it
 * for a choice it was entitled to make. **(2) must keep withholding**, because
 * it is the normal state of every pull request for the first seconds of its
 * life, which is exactly when the arrival edge fires. Mapping `null` to
 * `passing` outright would announce almost every card in the system reviewable
 * the instant its pull request opened, whatever CI later said.
 *
 * ── THE DISCRIMINATOR ─────────────────────────────────────────────────────
 * The two are indistinguishable AT THE PULL REQUEST, so the question is asked of
 * the REPOSITORY, from what Motir has already recorded about it:
 *
 *   - **It has recorded a check run, ever** ⇒ it CAN report. Its silence on this
 *     pull request means "not yet", and the card is held.
 *   - **It has never recorded one, AND at least one of its pull requests reached
 *     MERGE without ever recording one** ⇒ it CANNOT report. A merged pull
 *     request had its entire lifetime to produce a check and produced none; that
 *     is evidence, where "a pull request exists" is only a lack of it.
 *   - **Neither** — a repository with no history at all ⇒ treated as ABLE to
 *     report, which HOLDS the card. Absence of evidence resolves to the
 *     conservative side, deliberately.
 *
 * Its cost: two indexed reads, and only for a delivery whose verdict came back
 * `null` — so nearly every card pays nothing at all. No GitHub API call, no
 * cached column, and nothing for a human to configure. It is self-correcting in
 * both directions: the first check row a repository records answers it for ever,
 * and so does the first merge without one.
 *
 * ── WHAT IT ANSWERS, AND WHAT IT DOES NOT ────────────────────────────────
 * It answers *"can this REPOSITORY report a check?"* It does NOT answer *"will
 * anything report for THIS pull request?"* — a repository whose workflows are
 * paths-filtered can be perfectly able to report and stay silent on a docs-only
 * pull request, and such a card is still held at `implemented`. That is the
 * conservative direction and it is deliberate: the alternative reads a silence
 * as a pass, which is the regression above.
 *
 * **The residual failure, stated so the next reader does not over-trust it:** a
 * genuinely CI-less repository holds its cards until ONE of its pull requests
 * has merged. Bounded to the start of a repository's life, in the safe
 * direction, and it clears itself. The mirror failure — a repository that HAS CI
 * but has never run it promoting a card early — is what the merge evidence buys
 * out: its first pull request cannot have merged-without-reporting before its
 * first check unless CI genuinely never ran for it.
 *
 * `docs/decisions/ci-less-repository-is-green.md` is the record.
 */
export interface RepoCheckReportingFact {
  repoId: string;
  /** Has ANY pull request in this repository ever recorded a check run? */
  hasEverReportedACheck: boolean;
  /** Has at least one of its pull requests MERGED without recording one? */
  hasMergedWithoutAnyCheck: boolean;
}

/**
 * Is this repository unable to report a check — so a `null` verdict from it is
 * "no CI" rather than "no verdict yet"?
 *
 * Pure, and deliberately NOT in the repository layer: which facts amount to
 * evidence is a judgement, and a judgement belongs where it can be read and
 * asserted without a database.
 */
export function repoCannotReportChecks(fact: RepoCheckReportingFact): boolean {
  if (fact.hasEverReportedACheck) return false;
  return fact.hasMergedWithoutAnyCheck;
}

/**
 * One delivery's contribution to `deliverySetIsGreen`, with the second question
 * asked (MOTIR-3823).
 *
 * ⚠️ IT AMENDS THE PROMOTION'S READING, NEVER `derivePrCiState`. The shared
 * derivation keeps its meaning — `null` is still "absence of CI is not a state",
 * and every surface reading it (the Development pill, the `deliveries` field) is
 * untouched. Only the promotion asks the follow-up, because only the promotion
 * has to turn an absence into a yes or a no.
 *
 * Every non-null state passes through unchanged, which is what keeps this
 * invisible for the overwhelming majority of cards.
 */
export function deliveryStateForPromotion(
  state: string | null,
  cannotReportChecks: boolean,
): string | null {
  if (state !== null) return state;
  return cannotReportChecks ? 'passing' : null;
}
