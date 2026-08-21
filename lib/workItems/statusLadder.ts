import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE STATUS LADDER — the one ordering of "how far along is this" that both
// halves of status derivation and the container-completeness gate read
// (`docs/decisions/status-derivation.md` §3; Bug MOTIR-3229).
//
// It lived as a private constant plus a private `rankOfStatus` inside
// `parentStatusRollupService`, which was correct while derivation was the only
// reader. MOTIR-3229 added a SECOND reader — the gate in
// `workItemsService.applyStatusTransition` that refuses a container's claim to
// be built while a child is not — and two copies of an ordering is exactly the
// shape that drifts: the rung set is a semantic decision recorded in an ADR, and
// a gate ranking statuses differently from the derivation it is protecting would
// refuse and derive on two different scales.
//
// ⚠️ FIVE RUNGS, NOT FOUR (MOTIR-3229). `implemented` (MOTIR-3003) ships in the
// default workflow between `in_progress` and `in_review`, and the ladder could
// not see it: its CATEGORY is `in_progress`, so a parent whose children were ALL
// implemented derived to `in_progress` and the ladder had no way to say
// "everything below me is built" — precisely the state a story run ends in.
// MOTIR-1343 reached `implemented`, then `in_review`, then `done` with two `todo`
// children, and the merge cascaded both closed.
//
// ⚠️ AND THE RUNGS ARE STILL A FIXED SET, WHICH IS THE NARROW ANSWER. The
// general one — rank a project's OWN configured statuses rather than a fixed
// five — is not merely bigger: it has no defined answer for the statuses that
// are not on a line. `blocked` and `planning` are both real default statuses that
// sit BESIDE the path rather than along it, and a total order over an arbitrary
// project's status set would have to invent a place for them. This ladder ranks
// by CATEGORY with the two named lifecycle keys pulled out, so a project that
// adds statuses gets them ranked by the category it chose and nothing has to
// guess. MOTIR-3229's card names the general answer as the eventual direction;
// it is a redesign of §3, not a bug fix.

/** The rungs, in ascending order of "how far along". */
export type LadderRung = 'todo' | 'in_progress' | 'implemented' | 'in_review' | 'done';

/**
 * Where each rung sits on the scale. Comparable integers rather than an ordered
 * array lookup, because every reader compares two rungs rather than iterating.
 */
export const RUNG_RANK: Readonly<Record<LadderRung, number>> = Object.freeze({
  todo: 0,
  in_progress: 1,
  implemented: 2,
  in_review: 3,
  done: 4,
});

/**
 * The ladder as the UPWARD recompute reads it — highest rung FIRST, so "the
 * first matching rung wins" is a plain scan. Each entry names the INTENT it
 * wants; the concrete key is resolved against the project's own workflow by
 * `workflowsService.resolveStatusKey`, so a renamed workflow still derives.
 */
export const LADDER: ReadonlyArray<{
  rung: LadderRung;
  target: { key: string; category: StatusCategoryDto };
}> = Object.freeze([
  { rung: 'done', target: { key: 'done', category: 'done' } },
  { rung: 'in_review', target: { key: 'in_review', category: 'in_progress' } },
  { rung: 'implemented', target: { key: 'implemented', category: 'in_progress' } },
  { rung: 'in_progress', target: { key: 'in_progress', category: 'in_progress' } },
  { rung: 'todo', target: { key: 'todo', category: 'todo' } },
]);

/** The two lifecycle keys the ladder pulls OUT of the `in_progress` category,
 *  because both live in it and neither means what the other does. A project may
 *  have renamed either, so every reader resolves them rather than assuming. */
export interface LadderKeys {
  /** The project's In Review status key, or null when it has none. */
  readonly reviewKey: string | null;
  /** The project's Implemented status key, or null when it has none. */
  readonly implementedKey: string | null;
}

/**
 * Where a status sits on the ladder's scale.
 *
 * Ranked by CATEGORY — so it follows a project's own workflow — with the two
 * named lifecycle keys pulled out of `in_progress` as their own, later rungs. An
 * unknown key ranks lowest, which is the conservative reading everywhere it is
 * used: a status nobody can classify is not evidence that anything is finished.
 *
 * PURE, deliberately. It used to be an async method issuing one `getStatusByKey`
 * per call from inside a locked transaction; its callers now read the project's
 * status list once and rank against it, which is the same answer with one query
 * instead of one per status compared.
 */
export function rankOfStatus(
  statusKey: string,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  keys: LadderKeys,
): number {
  // The named keys win over the category, and REVIEW wins over IMPLEMENTED on
  // the (pathological) project that has aliased them onto one key: the higher
  // rung is the conservative answer for the derivation and the stricter one for
  // the gate.
  if (keys.reviewKey && statusKey === keys.reviewKey) return RUNG_RANK.in_review;
  if (keys.implementedKey && statusKey === keys.implementedKey) return RUNG_RANK.implemented;
  const status = statuses.find((s) => s.key === statusKey);
  if (!status) return RUNG_RANK.todo;
  if (status.category === 'done') return RUNG_RANK.done;
  if (status.category === 'in_progress') return RUNG_RANK.in_progress;
  return RUNG_RANK.todo;
}

/**
 * THE CONTAINER-COMPLETENESS BAR (MOTIR-3229) — the two status KEYS at which an
 * item CLAIMS its own work is built, and therefore the two a container may not
 * reach while a child of its own is not.
 *
 * `implemented` says the branch is pushed and the pull request is open;
 * `in_review` says a human should look at it. Both are claims about everything
 * under the item, and MOTIR-1343 made both while two children sat at `todo`.
 * `done` is deliberately NOT here: completing a parent is a decision that
 * completes its children, and §4's downward cascade is the shipped expression of
 * it — a gate there would break the feature rather than the defect.
 *
 * ⚠️ THIS IS THE KIND-AGNOSTIC CONTAINMENT, AND IT HAS COVERED `in_review` SINCE
 * IT SHIPPED (Bug MOTIR-3334, 2026-08-21). MOTIR-3334 asked, conditionally, why
 * the gate covered `implemented` and not `in_review` — *"if that guard already
 * exists for `implemented` … this card says why it did not cover `in_review`"*.
 * It did cover it: the set below has held BOTH keys since MOTIR-3229, and
 * `workItemsService.applyStatusTransition` tests membership in it for every
 * non-`system` move. The premise was false, and it is recorded here rather than
 * left for the next reader to re-derive from the same conditional.
 *
 * What is true is the OTHER half of that card's containment — a container may not
 * be moved here while a child is unimplemented, and it also may not have its pull
 * request opened by a scoped run in that state, which is `packages/cli`'s
 * close-out re-read (MOTIR-3268). Both are kind-agnostic. Neither reaches a child
 * FILED AFTER the parent finished, which is why the downward cascade dates its
 * own claim (`childStatusCascadeService`, same card) — a residue, not a
 * duplicate.
 *
 * ⚠️ BY KEY, NOT BY CATEGORY, AND NOT THROUGH `resolveStatusKey`. Both statuses
 * live in the `in_progress` category, so the prefer-key-then-category resolver
 * falls back to the FIRST `in_progress` status — `in_progress` itself — and the
 * gate would fire on a status that claims nothing at all. A project that renamed
 * these away has redefined what the claim means, and the honest answer there is
 * to let the move through rather than to refuse it on a status we cannot read.
 * The same literal-key choice `ciPromotion.ts` makes, for the same reason.
 */
export const CONTAINER_CLAIM_STATUS_KEYS: ReadonlySet<string> = new Set([
  'implemented',
  'in_review',
]);

/**
 * The bar every live child must clear before a container may enter one of those
 * two statuses: `implemented`-or-better.
 *
 * ONE bar for BOTH claim rungs, rather than the target's own rank. The rule the
 * card states is *"a story must not be able to claim `implemented` while a child
 * is not implemented"*, and reading In Review's own rank as the bar would
 * additionally refuse a parent whose children are all built but whose individual
 * builds have not been promoted — which is the ordinary shape of a parent run,
 * where ONE pull request carries every child and the promotion is a single
 * verdict over the set. Refusing there would gate a true claim on an artifact of
 * how CI reports.
 */
export const CONTAINER_CLAIM_BAR_RANK = RUNG_RANK.implemented;

/**
 * The live children that have NOT reached the completeness bar — the ones whose
 * existence makes a container's claim false.
 *
 * Takes rows rather than ids so the caller can name them in the refusal: an
 * error that says WHICH cards are open is one the reader can act on, and this
 * gate fires at the moment somebody believes they are finished.
 */
export function childrenBelowClaimBar<T extends { status: string }>(
  children: ReadonlyArray<T>,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  keys: LadderKeys,
): T[] {
  return children.filter(
    (child) => rankOfStatus(child.status, statuses, keys) < CONTAINER_CLAIM_BAR_RANK,
  );
}
