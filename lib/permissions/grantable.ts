import { isEnforced, type PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';

// What ANY role may hold — a workspace built-in's set, or a custom role's
// (Story MOTIR-2257, moved here by Story MOTIR-6168 · MOTIR-6466 when the
// project roles service that housed it was deleted with the project Roles pages).

/**
 * The set a role may draw from: role-gated AND `enforced`.
 *
 * ⚠️ DERIVED FROM THE CONSTANTS, never a literal list. The `enforcement` marker
 * exists precisely so a key no gate consults can never become a switch that
 * controls nothing — a settings screen showing such a switch is a promise the
 * code does not keep, and it is the failure this whole epic was built to remove.
 * `PLANNED_PERMISSIONS` is empty on `origin/main` today, so this refuses nothing
 * in practice; it is written this way so the NEXT planned key is refused with no
 * code change. A level-gated `public_request:*` key is refused by the same
 * expression, for the same reason: no role can hold one.
 *
 * Computed lazily rather than at module load so a test can add a synthetic
 * non-enforced key and see the check follow it.
 */
export function grantablePermissionKeys(
  roleGated: readonly PermissionKey[] = ROLE_GATED_PERMISSIONS,
  enforced: (key: PermissionKey) => boolean = isEnforced,
): ReadonlySet<PermissionKey> {
  return new Set(roleGated.filter((key) => enforced(key)));
}
