import type { PermissionKey } from '@/lib/permissions/catalog';

// THE APPROVAL FRAME'S SETTINGS DOOR (Story MOTIR-4882 · MOTIR-5513, and MOTIR-4793;
// `design/work-items/design-notes.md` § AMENDED 2026-09-13 — the SETTINGS DOOR,
// `approval-control.mock.html` panel `S`; ADR `approval-gates.md` §7).
//
// A way OUT of being asked, supplied per KIND: someone who defaulted to *Ask
// before merging* and cannot read a diff must be able to find the switch that
// stops asking while they are stuck in front of the question. The frame renders it
// in band 3's left column, under the consequence line — never a verb, never beside
// the verbs.
//
// ⚠️ THE KIND SUPPLIES THE DOOR, AND THIS MODULE ONLY GATES IT. The door's values live
// on the kind's handler (`GateHandler.settingsDoor`, MOTIR-4793), so registering a
// kind is still a row in the enum, a handler and a renderer. This module takes the
// door rather than the kind so it never imports the registry: the registry imports
// the handlers, and a handler names a door type from here.
//
// ⚠️ IT IS GUARDED LIKE THE ROOM IT OPENS. The Approvals room and its route are
// behind `workflow:manage`, and there is no read-only room (Yue, 2026-09-13), so a
// door for a viewer without the key would lead to a refusal. The gate read hands a
// door out only to a holder; the frame never guesses.

/** The key the door's destination is guarded by — the Approvals room's own. */
export const SETTINGS_DOOR_PERMISSION: PermissionKey = 'workflow:manage';

/** One door: where it lands, and the message key its label is drawn from. */
export interface GateSettingsDoor {
  href: string;
  /** A key under `approvalGate.settingsDoor` — resolved by the rendering surface. */
  labelKey: 'mergeMode';
}

/**
 * The door THIS viewer is handed — the kind's own door when they hold the room's
 * key, and `null` otherwise, or when the kind supplies none. `null` renders nothing.
 */
export function settingsDoorFor(
  door: GateSettingsDoor | undefined,
  held: ReadonlySet<PermissionKey>,
): GateSettingsDoor | null {
  if (!door) return null;
  return held.has(SETTINGS_DOOR_PERMISSION) ? door : null;
}
