// WHAT A LIVE RE-READ DID TO A LIST (Story MOTIR-5238 · Subtask MOTIR-5242) —
// the two pure answers every live list needs, and the one rule that makes them
// safe: A NUDGE ADDS AND UPDATES; IT NEVER REMOVES.
//
// `design/workbench/design-notes.md` § 26 settles it, amending § 20:
//
//   "A row that is in the reader's list stays in the reader's list until the
//    NEXT LOAD — a navigation, a tab switch, a pager move, a reload. A row that
//    has left the awaiting set is HELD in place … The strip count goes DOWN with
//    it, because § 20's count is about what is AWAITING and a held row is a
//    receipt, not a member."
//
// ⚠️ WHY THIS IS A PURE MODULE AND NOT A HOOK BODY. The rule is a set
// computation over two orderings, and the case it exists for — a row decided by
// SOMEBODY ELSE while the reader was looking at it — is reachable in a test only
// by driving two prop sets through it. Keeping it out of React means the rule can
// be asserted directly rather than through a render, and it is one implementation
// for both lists rather than two that drift (§ 26 planning flag 1).

/** How a caller names a row — its stable identity across re-reads. */
export type RowId<T> = (row: T) => string;

/**
 * The rows the reader can SEE, after a re-read — the server's, plus the ones it
 * dropped, each kept exactly where it was.
 *
 * ⚠️ POSITION IS PRESERVED, NOT APPENDED. A held row that jumped to the bottom
 * would be the disappearance § 20 forbids, wearing a different costume: the
 * reader looks back at the place they were reading and the row is not there. So
 * the merge walks the PREVIOUS ordering and splices the server's new rows in at
 * their own positions.
 */
export function mergeHeldRows<T>(
  previous: readonly T[],
  incoming: readonly T[],
  idOf: RowId<T>,
): { rows: T[]; heldIds: Set<string> } {
  const incomingById = new Map(incoming.map((row) => [idOf(row), row]));
  const seen = new Set<string>();
  const heldIds = new Set<string>();
  const rows: T[] = [];

  // Every row the reader already had, in the order they had it: updated in place
  // when the server still returns it, HELD when it does not.
  for (const row of previous) {
    const id = idOf(row);
    seen.add(id);
    const fresh = incomingById.get(id);
    if (fresh) {
      rows.push(fresh);
    } else {
      rows.push(row);
      heldIds.add(id);
    }
  }
  // Then the arrivals, in the server's own order — which is the tab's order, so
  // an arrival lands where the tab would have put it on a reload.
  for (const row of incoming) {
    if (!seen.has(idOf(row))) rows.push(row);
  }
  return { rows, heldIds };
}

/**
 * The rows that ARRIVED — present now, absent from the reader's previous set.
 *
 * ⚠️ EMPTY ON THE FIRST READING, and that is the decision rather than a base
 * case falling out of the loop. A reader who has just landed has had nothing
 * arrive under them: every row is equally new to them, and marking all of them
 * `New` would say something false on the one render where the chip means
 * nothing. So a caller with no previous set gets an empty answer, and the chip
 * appears only on a row that arrived while somebody was looking.
 */
export function arrivedRowIds<T>(
  previous: readonly T[] | null,
  incoming: readonly T[],
  idOf: RowId<T>,
): Set<string> {
  if (previous === null) return new Set();
  const had = new Set(previous.map(idOf));
  return new Set(incoming.map(idOf).filter((id) => !had.has(id)));
}
