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
