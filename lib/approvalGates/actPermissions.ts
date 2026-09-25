import type { PermissionKey } from '@/lib/permissions/catalog';

// WHO CAN ACT IN THE APPROVALS ROOM (Story MOTIR-6179 · MOTIR-6333) — the keys the
// decide door accepts, stated ONCE. The room shows its Mine view to a reader who
// holds any of them, and the `/approvals` nav door (MOTIR-6332,
// `lib/settings/projectNavAccess.ts`) opens on any of them OR `approval:view_any`,
// so the page and the door cannot disagree about who may act here.
//
//   * every per-kind FLOOR a registered gate handler names
//     (`APPROVAL_GATE_HANDLERS[kind].permission`: `work_item:edit`, and
//     `ai:decide_plan` for a plan) — the door asserts it before anything else;
//   * `approval:decide_any` — the escape hatch that decides anyone's gate.
//
// Routing itself needs no key: a gate is routed to its card's assignee (or
// reporter), and the floor above is what that person must hold to decide it.
//
// A LEAF literal rather than a derivation, because the registry pulls in every
// handler (and through them the services), and the nav map is read by client
// bundles. `tests/approvalGates/actPermissions.test.ts` asserts it equals the
// registry's floors plus `approval:decide_any`, so a new handler's key cannot be
// left out.
export const APPROVAL_ACT_PERMISSIONS: readonly PermissionKey[] = [
  'work_item:edit',
  'approval:decide_any',
  'ai:decide_plan',
];

/** Whether a reader holding `held` can act in the Approvals room. */
export function canActOnApprovals(held: ReadonlySet<PermissionKey>): boolean {
  return APPROVAL_ACT_PERMISSIONS.some((key) => held.has(key));
}
