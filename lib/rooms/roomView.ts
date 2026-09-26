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

import type { PermissionKey } from '@/lib/permissions/catalog';

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

/**
 * {@link resolveRoomView} with the Mine probe ALREADY READ — the same rule, for a
 * page that ran the probe in the same wave as its other reads rather than after
 * them (the serial-read ratchet, `tests/navigation/loading-boundary-guard.test.ts`).
 * `mineHasRows` is null when the probe was not run, which is only correct when the
 * rule never consults it (a valid `requested`, or fewer than two views); a null
 * there reads as "no rows", so a page that skipped the probe lands on Project.
 */
export function pickRoomView(args: {
  requested: RoomView | null;
  available: readonly RoomView[];
  mineHasRows: boolean | null;
}): RoomView | null {
  const { requested, available } = args;
  if (available.length === 0) return null;
  if (requested && available.includes(requested)) return requested;
  if (available.length === 1) return available[0]!;
  return args.mineHasRows ? 'mine' : 'project';
}

/**
 * "Can act" in the PLANS room (design MOTIR-6327 § the readers): author a plan
 * (`ai:plan`) or decide one (`ai:decide_plan`). The page and MOTIR-6332's nav
 * row read this one list.
 */
export const PLAN_ACT_PERMISSIONS: readonly PermissionKey[] = ['ai:plan', 'ai:decide_plan'];

/**
 * "Can act" in the RUNS room: start a run — `work_item:edit`, what
 * `dispatchRunService.open` asserts.
 */
export const RUN_ACT_PERMISSIONS: readonly PermissionKey[] = ['work_item:edit'];

/** Whether `held` holds any of a room's act keys. */
export function holdsAnyOf(
  held: ReadonlySet<PermissionKey>,
  keys: readonly PermissionKey[],
): boolean {
  return keys.some((key) => held.has(key));
}
