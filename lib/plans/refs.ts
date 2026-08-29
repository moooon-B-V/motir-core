// The intra-plan temp-ref contract (Story 7.21 · MOTIR-1336), extracted here so
// the persist-time confirmation gate (7.12.5 · MOTIR-911) can share it with
// `plansService` without importing the service (which would be a module cycle —
// the service imports the gate).
//
// A PlanItem's `parentRef` / `blockedByRefs` entry is EITHER a real
// `work_item.id` OR a temp-ref `planItem:<planItemId>` pointing at another `add`
// in the SAME plan (resolved to the created work-item id at materialize).
// `plansService` re-exports `TEMP_REF_PREFIX` so its existing consumers
// (`planValidityService`) keep importing it from there unchanged.

/** The intra-plan temp-ref prefix: `planItem:<planItemId>`. */
export const TEMP_REF_PREFIX = 'planItem:';

/** True when `ref` points at another `add` in the same plan (not a real id). */
export function isTempRef(ref: string): boolean {
  return ref.startsWith(TEMP_REF_PREFIX);
}

/** The PlanItem id inside a temp-ref (`planItem:abc` → `abc`). */
export function tempRefId(ref: string): string {
  return ref.slice(TEMP_REF_PREFIX.length);
}

// ── The APPEND-time resolvability check (Story MOTIR-3533 · Subtask MOTIR-3539) ─
//
// A temp-ref is decidable the instant it arrives. The contract above fixes what
// one may name — an `add` on THIS plan — and `add_plan_items` returns a
// proposal's id only when its own call returns, so the resolvable set at append
// time is exactly the plan's ALREADY-PERSISTED `add`s. Nothing a later call does
// can rescue a ref outside that set, which is why deferring the check to approve
// bought nothing at all: the same answer, from the same data, delivered days
// later to a reviewer who did not write it and cannot fix it.
//
// ⚠️ FIVE CARRIERS, NOT TWO. An intra-plan edge travels on `blockedByRefs` when
// the proposal is an `add` and on `patch.blockedByAdd` / `patch.blockedByRemove`
// when it is a `modify` — and the artifact this card was written from is the
// SECOND shape (`blockedByAdd: ['planItem:PLACEHOLDER']` on a `modify`). A check
// that read only an `add`'s own fields would have shipped without refusing the
// one plan it exists to refuse.
//
// ⚠️ AND `patch.parentRef` IS THE FIFTH (MOTIR-3859), listed here even though the
// append refuses a temp-ref on it OUTRIGHT — a re-parent's guards are all
// questions about a live row, so a proposal is not a legal parent for one. The
// site is enumerated anyway because this function's job is to be TOTAL over a
// proposal's ref carriers: a later card that admits a temp-ref there must not
// also have to remember this file.
//
// PURE — no Prisma, no DB — so the service resolves the existing-id set and this
// decides. That is what makes it unit-testable without a database and what lets
// the correction path (MOTIR-3540) reuse it verbatim rather than growing a
// second, drifting copy.

/** Where in a proposal a ref was found — quoted verbatim in the refusal. */
export type PlanRefSite =
  | 'parentRef'
  | 'blockedByRefs'
  | 'patch.parentRef'
  | 'patch.blockedByAdd'
  | 'patch.blockedByRemove';

/** One proposal, in the minimal shape the append-time ref check reads. */
export interface ProposalRefCarrier {
  /** How to name this proposal in a refusal (`proposalLabel`'s output). */
  label: string;
  parentRef?: string | null;
  blockedByRefs?: readonly string[] | null;
  patch?: {
    parentRef?: string | null;
    blockedByAdd?: string[] | null;
    blockedByRemove?: string[] | null;
  } | null;
}

/** Every temp-ref a proposal carries, with the field it was carried on. */
export function tempRefsOf(p: ProposalRefCarrier): Array<{ ref: string; where: PlanRefSite }> {
  const out: Array<{ ref: string; where: PlanRefSite }> = [];
  const take = (ref: string | null | undefined, where: PlanRefSite): void => {
    if (ref && isTempRef(ref)) out.push({ ref, where });
  };
  take(p.parentRef, 'parentRef');
  for (const ref of p.blockedByRefs ?? []) take(ref, 'blockedByRefs');
  take(p.patch?.parentRef, 'patch.parentRef');
  for (const ref of p.patch?.blockedByAdd ?? []) take(ref, 'patch.blockedByAdd');
  for (const ref of p.patch?.blockedByRemove ?? []) take(ref, 'patch.blockedByRemove');
  return out;
}

/**
 * Throw on the FIRST temp-ref in `proposals` that names no id in
 * `resolvableAddIds`. A real work-item id is not touched: it is the other legal
 * form, its resolution needs a live read, and this check deliberately stays the
 * cheap total one the temp-ref contract already makes decidable.
 *
 * @param proposals the whole batch — checked BEFORE the first row is written, so
 *   a refusal leaves the plan byte-identical rather than partially appended.
 * @param resolvableAddIds the ids of the `add` proposals this plan ALREADY
 *   holds. A ref to a proposal in the same batch is therefore refused, which is
 *   the case the contract forbids and the one that produced the live artifact.
 * @param error builds the refusal; injected so this module stays free of the
 *   error class and the caller decides what surfaces.
 */
export function assertTempRefsResolvable(
  proposals: readonly ProposalRefCarrier[],
  resolvableAddIds: ReadonlySet<string>,
  error: (ref: string, proposal: string) => Error,
): void {
  for (const p of proposals) {
    for (const { ref } of tempRefsOf(p)) {
      if (!resolvableAddIds.has(tempRefId(ref))) throw error(ref, p.label);
    }
  }
}
