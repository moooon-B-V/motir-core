// THE ROOM VIEW (Story MOTIR-6179 · design MOTIR-6327, `design/approvals/design-notes.md`
// § *Mine / Project — the view switch on Plans, Approval records and Runs*).
//
// Plans, Approval records and Runs each show a reader either the rows that are
// THEIRS (`mine`) or every row of the project (`project`). Which views a reader
// HAS is a fact about their permission keys, never their role name:
//
//   * `project` — the reader holds the room's view-any key;
//   * `mine`    — the reader can ACT in the room (author or decide a plan, be
//                 routed or decide a gate, start a run).
//
// A reader with both gets the switch; with one, that view alone and no switch;
// with neither, the room's not-found face. PURE — no I/O — so the three rooms'
// pages, their services and their tests read one statement of the rule.

/** Which rows a room shows. The URL spells it `?view=mine|project`. */
export type RoomView = 'mine' | 'project';

/** The URL parameter the switch writes. */
export const ROOM_VIEW_PARAM = 'view';

/** The views in the order the switch draws them — always Mine, then Project. */
export const ROOM_VIEWS: readonly RoomView[] = ['mine', 'project'];

/** `?view=` as a view, or null for an absent or unknown value (treated as absent). */
export function parseRoomView(raw: string | string[] | null | undefined): RoomView | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'mine' || value === 'project' ? value : null;
}

/** The views this reader HAS, in switch order. Empty ⇒ the room is closed to them. */
export function availableRoomViews(reader: { hasViewKey: boolean; canAct: boolean }): RoomView[] {
  return ROOM_VIEWS.filter((view) => (view === 'mine' ? reader.canAct : reader.hasViewKey));
}

/**
 * The view to SERVE.
 *
 *   * a requested view the reader has — that view;
 *   * one view available — that one, whatever was asked (a `view` the reader may
 *     not have falls back SILENTLY, never an error and never an empty room);
 *   * both, nothing (valid) asked — Mine when Mine has at least one row, else
 *     Project. `mineHasRows` is only called in that case, so the extra read is
 *     paid only by a two-view reader landing on a clean URL;
 *   * none — null: the room is closed to this reader.
 */
export async function resolveRoomView(args: {
  requested: RoomView | null;
  available: readonly RoomView[];
  mineHasRows: () => Promise<boolean>;
}): Promise<RoomView | null> {
  const { requested, available } = args;
  if (available.length === 0) return null;
  if (requested && available.includes(requested)) return requested;
  if (available.length === 1) return available[0]!;
  return (await args.mineHasRows()) ? 'mine' : 'project';
}
