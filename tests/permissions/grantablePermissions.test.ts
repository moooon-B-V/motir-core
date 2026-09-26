import { describe, expect, it } from 'vitest';
import { grantablePermissionKeys } from '@/lib/permissions/grantable';
import { MAX_CUSTOM_ROLES_PER_PROJECT, MAX_ROLE_NAME_LENGTH } from '@/lib/permissions/limits';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { isEnforced, type PermissionKey } from '@/lib/permissions/catalog';

// What is LEFT of `projectRoleDefinitionService` (Story MOTIR-2257) once the
// project roles retired as grants (Story MOTIR-6168 · MOTIR-6464): the rule for
// what ANY role may hold, which the WORKSPACE roles service reuses. Creating,
// renaming, re-permissioning and deleting a role — with its name bound, its cap
// and its delete-with-reassign — moved to the workspace, and those rules are
// tested there (`tests/workspaces/workspaceRoleRoutes.test.ts`). The project
// Roles pages' catalog read goes with them in MOTIR-6466.

describe('a permission no gate consults can never be granted', () => {
  it('THE CHECK READS `isEnforced`, proven with a SYNTHETIC non-enforced key', () => {
    // The AC that matters: a hardcoded list would pass every other test and still
    // be wrong the day a `planned` key is added. So drive the derivation directly
    // with a key the predicate reports as NOT enforced, and show it is excluded —
    // while every genuinely enforced key survives.
    const synthetic = 'synthetic:planned' as PermissionKey;
    const derived = grantablePermissionKeys(
      [...ROLE_GATED_PERMISSIONS, synthetic],
      (key) => key !== synthetic,
    );
    expect(derived.has(synthetic)).toBe(false);
    for (const key of ROLE_GATED_PERMISSIONS.filter((k) => isEnforced(k))) {
      expect(derived.has(key), `${key} was dropped`).toBe(true);
    }

    // With today's real predicate the grantable set IS the enforced role-gated
    // set — a level-gated key (`public_request:*`) is never in it.
    expect([...grantablePermissionKeys()].sort()).toEqual(
      ROLE_GATED_PERMISSIONS.filter((k) => isEnforced(k)).sort(),
    );
    expect(grantablePermissionKeys().has('public_request:submit' as PermissionKey)).toBe(false);
  });

  it('`approval:view_any` is grantable — the room follows the key, not a role (MOTIR-5301)', () => {
    expect(grantablePermissionKeys().has('approval:view_any')).toBe(true);
  });
});

describe('`lib/permissions/limits.ts` is a PURE constants module', () => {
  it('imports nothing — so a client component can read the cap the server enforces', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../../lib/permissions/limits.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/@\/lib\/db/);
    expect(MAX_CUSTOM_ROLES_PER_PROJECT).toBeGreaterThan(0);
    expect(MAX_ROLE_NAME_LENGTH).toBeGreaterThan(0);
  });
});
