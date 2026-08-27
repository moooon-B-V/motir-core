// The import preview's DERIVED-PARENT-STATUS disclosure (Task MOTIR-2974 — the
// FIDELITY half split out of MOTIR-2902). Pure: no DB, no Prisma, no writes —
// the caller (`importService.preview`) supplies the two reads.
//
// WHY THIS EXISTS. A CSV carries a `status` column, and the wizard's own Map
// step tells the user it is mapping that column onto a Motir workflow status.
// For a row that becomes a PARENT that is only half true: the mapped value IS
// applied (`setImportedStatus`, a real write with a real revision), and then
// the shipped upward recompute (`docs/decisions/status-derivation.md` §3,
// amended 2026-08-17 by MOTIR-2888) reads the child set and moves the parent —
// exactly as it does for a parent a person set by hand. The 2026-08-27
// amendment settles that this is CORRECT and adds this disclosure as the price
// of it: the user is told BEFORE the run, not left to discover it after.
//
// WHY IT CANNOT LIVE IN `importResolver`. "Does this row become a parent?" is a
// question about the OTHER rows, and the resolve→classify path is deliberately
// STREAMED one issue at a time so a 10k-issue preview is never one giant
// payload. `importService.preview` is the first tier that holds the whole set,
// so the annotation is a post-pass there rather than a per-issue rule.

import type { ImportPlanRow } from './types';

/**
 * The mark, as the preview renders it — one more `Pill severity="warning"` in
 * the per-row warnings the shipped `PreviewStep` already draws (the design of
 * record's `status → default` warn pill, `design/import/design-notes.md`
 * § Preview). Plain English like every other member of `ImportPlanRow.warnings`
 * — that channel is server-authored prose, not an i18n key.
 *
 * ⚠️ It names the MECHANISM, never a predicted value. Predicting the derived
 * status would mean running the ladder's rung-matching + stepping-stone walk
 * (`parentStatusRollupService`) over a child set that does not exist yet, and a
 * preview that names a status the run then does not produce is worse than one
 * that names none. What the mark claims is exactly what is always true of such
 * a row: its status is a function of its children, so the file does not govern
 * it.
 */
export const DERIVED_PARENT_STATUS_WARNING =
  "status is derived from this issue's children — the value in the file is a starting point";

export interface DerivedParentStatusOptions {
  /**
   * The project's `autoRollupParentStatus` toggle (ADR §2). OFF ⇒ no parent's
   * status is derived, so there is nothing to disclose and nothing is marked.
   */
  autoRollupParentStatus: boolean;
  /**
   * Work-item ids that ALREADY have at least one non-archived, non-triage child
   * in Motir — for the rows this import matched to an existing item (UPDATE and
   * SKIP). Such a row is a parent whether or not this import gives it a new
   * child, so its status is derived either way.
   */
  existingParentIds?: ReadonlySet<string>;
}

/**
 * Push {@link DERIVED_PARENT_STATUS_WARNING} onto every plan row that will be a
 * PARENT once this import has run — in place, onto the same `warnings` array
 * the resolver writes, so it reaches the user through the shipped renderer with
 * no UI change and is counted by the summary callout for free.
 *
 * A row qualifies when either half holds:
 *  - **another row in this import names it as its parent** (`parentExternalId`),
 *    so this run gives it a child; or
 *  - it matched an existing Motir item that already has children.
 *
 * The claim is about the row's SHAPE after the run, not about a write: a parent
 * whose mapped status already equals the derived one is still a row whose
 * status is governed by its children, and that is the fidelity fact the file's
 * author needs. Deliberately no attempt to predict WHETHER the value changes —
 * see the note on the constant.
 */
export function markDerivedParentStatuses(
  rows: ImportPlanRow[],
  opts: DerivedParentStatusOptions,
): void {
  if (!opts.autoRollupParentStatus) return;

  const namedAsParent = new Set<string>();
  for (const row of rows) {
    if (row.payload.parentExternalId) namedAsParent.add(row.payload.parentExternalId);
  }

  for (const row of rows) {
    const gainsAnImportedChild = namedAsParent.has(row.externalId);
    const alreadyHasChildren =
      row.existingWorkItemId !== null &&
      (opts.existingParentIds?.has(row.existingWorkItemId) ?? false);
    if (gainsAnImportedChild || alreadyHasChildren) {
      row.warnings.push(DERIVED_PARENT_STATUS_WARNING);
    }
  }
}
