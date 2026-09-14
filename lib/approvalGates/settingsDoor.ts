import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';
import type { PermissionKey } from '@/lib/permissions/catalog';

// THE APPROVAL FRAME'S SETTINGS DOOR (Story MOTIR-4882 · MOTIR-5513;
// `design/work-items/design-notes.md` § AMENDED 2026-09-13 — the SETTINGS DOOR,
// `approval-control.mock.html` panel `S`; ADR `approval-gates.md` §7).
//
// A way OUT of being asked, supplied per KIND: someone who defaulted to *Ask
// before merging* and cannot read a diff must be able to find the switch that
// stops asking while they are stuck in front of the question. The frame renders it
// in band 3's left column, under the consequence line — never a verb, never beside
// the verbs.
//
// ⚠️ IT IS GUARDED LIKE THE ROOM IT OPENS. The Approvals room and its route are
// behind `workflow:manage`, and there is no read-only room (Yue, 2026-09-13), so a
// door for a viewer without the key would lead to a refusal. The gate read hands a
// door out only to a holder; the frame never guesses.
//
// ⚠️ ONLY A KIND WITH A PROJECT SETTING HAS ONE. A design result has nothing a
// project setting changes, so its frame renders no door and band 3 stays
// byte-identical to state `A`.

/** The key the door's destination is guarded by — the Approvals room's own. */
export const SETTINGS_DOOR_PERMISSION: PermissionKey = 'workflow:manage';

/** One door: where it lands, and the message key its label is drawn from. */
export interface GateSettingsDoor {
  href: string;
  /** A key under `approvalGate.settingsDoor` — resolved by the rendering surface. */
  labelKey: 'mergeMode';
}

/**
 * The doors, per kind. The merge kind's lands on the merge-mode setting at
 * `PrMergeModeCard`'s `#merge-mode` anchor (MOTIR-5181), in the same tab.
 */
export const GATE_SETTINGS_DOORS: Readonly<Partial<Record<ApprovalGateKindDTO, GateSettingsDoor>>> =
  {
    pull_request_merge: {
      href: '/settings/project/approvals#merge-mode',
      labelKey: 'mergeMode',
    },
  };

/**
 * The door THIS viewer is handed for a gate of `kind` — the kind's own door when
 * they hold the room's key, and `null` otherwise. `null` renders nothing.
 */
export function settingsDoorFor(
  kind: ApprovalGateKindDTO,
  held: ReadonlySet<PermissionKey>,
): GateSettingsDoor | null {
  if (!held.has(SETTINGS_DOOR_PERMISSION)) return null;
  return GATE_SETTINGS_DOORS[kind] ?? null;
}
