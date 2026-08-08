import { describe, expect, it } from 'vitest';
import {
  toBuiltinRoleDTO,
  toLevelGatedDomainDTOs,
  toPermissionDomainDTOs,
  toRoleCatalogDTO,
} from '@/lib/mappers/permissionMappers';
import { BUILTIN_ROLE_PERMISSIONS, ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PERMISSIONS, PERMISSION_DOMAINS } from '@/lib/permissions/catalog';
import { PROJECT_ASSIGNABLE_ROLES } from '@/lib/projects/roles';

// The widened role-catalog mapping (Subtask MOTIR-2439) — the three values the
// designed role LIST row draws and the shipped DTO could not express: the
// ROLE-GATED row set, each role's headcount, and the `M` in `N of M`.
//
// ⚠️ EVERY ASSERTION HERE IS AGAINST A CONSTANT, NEVER A LITERAL COUNT.
// `ROLE_GATED_PERMISSIONS` grew from 20 keys to 28 while this story was being
// planned and will grow again; an assertion spelling out `28` would be wrong
// today and right by accident tomorrow.

describe('toPermissionDomainDTOs draws the ROLE-GATED rows, not the whole catalog', () => {
  it('contains exactly the keys in ROLE_GATED_PERMISSIONS', () => {
    const keys = toPermissionDomainDTOs().flatMap((group) => group.permissions.map((p) => p.key));
    expect([...keys].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('omits the level-gated public_request keys and their heading', () => {
    const groups = toPermissionDomainDTOs();
    expect(groups.map((g) => g.domain)).not.toContain('public_request');
    for (const group of groups) {
      for (const permission of group.permissions) {
        expect(permission.key.startsWith('public_request:')).toBe(false);
      }
    }
  });

  it('labels every group and every row with an i18n key, never a raw catalog key', () => {
    for (const group of toPermissionDomainDTOs()) {
      expect(group.labelKey).toBe(`permissions.domain.${group.domain}`);
      expect(group.permissions.length).toBeGreaterThan(0);
      for (const permission of group.permissions) {
        expect(permission.labelKey).toMatch(/^permissions\.[a-z_]+\.label$/);
        expect(permission.descriptionKey).toMatch(/^permissions\.[a-z_]+\.description$/);
      }
    }
  });

  it('keeps catalog order inside a group and domain order across them', () => {
    const groups = toPermissionDomainDTOs();
    const domainPositions = groups.map((g) => PERMISSION_DOMAINS.indexOf(g.domain));
    expect(domainPositions).toEqual([...domainPositions].sort((a, b) => a - b));
    for (const group of groups) {
      const positions = group.permissions.map((p) => PERMISSIONS.indexOf(p.key));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe('toBuiltinRoleDTO carries the headcount alongside the set', () => {
  it('reports the count it was given', () => {
    expect(toBuiltinRoleDTO('member', 7).memberCount).toBe(7);
  });

  it('keeps the role identity and its set unchanged', () => {
    const dto = toBuiltinRoleDTO('viewer', 0);
    expect(dto.role).toBe('viewer');
    expect(dto.builtIn).toBe(true);
    expect(dto.labelKey).toBe('settings.roles.viewer.name');
    expect(dto.descriptionKey).toBe('settings.roles.viewer.description');
    expect([...dto.permissions].sort()).toEqual([...BUILTIN_ROLE_PERMISSIONS.viewer].sort());
  });
});

describe('toRoleCatalogDTO', () => {
  it('zero-fills a role nobody holds rather than omitting the key', () => {
    const catalog = toRoleCatalogDTO({ admin: 2 });
    expect(catalog.roles.map((r) => r.role)).toEqual([...PROJECT_ASSIGNABLE_ROLES]);
    expect(catalog.roles.find((r) => r.role === 'admin')?.memberCount).toBe(2);
    for (const role of catalog.roles) {
      expect(typeof role.memberCount, `${role.role} must carry a number`).toBe('number');
    }
    expect(catalog.roles.find((r) => r.role === 'member')?.memberCount).toBe(0);
    expect(catalog.roles.find((r) => r.role === 'viewer')?.memberCount).toBe(0);
  });

  it('defaults every count to zero when no counts are supplied at all', () => {
    expect(toRoleCatalogDTO().roles.map((r) => r.memberCount)).toEqual([0, 0, 0]);
  });

  it('carries the role-gated TOTAL, and it agrees with the rows it renders', () => {
    const catalog = toRoleCatalogDTO();
    expect(catalog.roleGatedPermissionCount).toBe(ROLE_GATED_PERMISSIONS.length);
    // Derived from the very groups the screens draw, so `M` can never disagree
    // with the rows above it.
    expect(catalog.roleGatedPermissionCount).toBe(
      catalog.domains.reduce((total, group) => total + group.permissions.length, 0),
    );
  });

  it('holds `N of M` true for every role — N never exceeds M', () => {
    const catalog = toRoleCatalogDTO();
    for (const role of catalog.roles) {
      expect(role.permissions.length).toBeLessThanOrEqual(catalog.roleGatedPermissionCount);
    }
    // Admin holds the whole role-gated set, which is what makes `M` the right
    // denominator rather than the catalog's own length.
    expect(catalog.roles.find((r) => r.role === 'admin')?.permissions.length).toBe(
      catalog.roleGatedPermissionCount,
    );
  });

  it('stays JSON-serialisable — no Set crosses the boundary', () => {
    const catalog = toRoleCatalogDTO({ admin: 1, member: 3, viewer: 5 });
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});

// The level-gated card the role LIST draws beneath the roles (MOTIR-2439). The
// design keeps `public_request:*` OUT of the role rows and explains them in their
// own card instead — so the read has to carry them, or the page describes less
// than the whole model.
describe('toLevelGatedDomainDTOs is the exact complement of the role rows', () => {
  it('together with the role-gated groups it covers the WHOLE catalog, once each', () => {
    const catalog = toRoleCatalogDTO();
    const roleGated = catalog.domains.flatMap((g) => g.permissions.map((p) => p.key));
    const levelGated = catalog.levelGatedDomains.flatMap((g) => g.permissions.map((p) => p.key));
    expect([...roleGated, ...levelGated].sort()).toEqual([...PERMISSIONS].sort());
    // Disjoint — a key on both screens would be described twice, once wrongly.
    expect(roleGated.filter((k) => levelGated.includes(k))).toEqual([]);
  });

  it('is exactly the keys no role can hold, derived rather than re-listed', () => {
    const levelGated = toLevelGatedDomainDTOs().flatMap((g) => g.permissions.map((p) => p.key));
    expect([...levelGated].sort()).toEqual(
      PERMISSIONS.filter((key) => !ROLE_GATED_PERMISSIONS.includes(key)).sort(),
    );
  });

  it('labels its group and rows the same way the role rows are labelled', () => {
    for (const group of toLevelGatedDomainDTOs()) {
      expect(group.labelKey).toBe(`permissions.domain.${group.domain}`);
      expect(group.permissions.length).toBeGreaterThan(0);
      for (const permission of group.permissions) {
        expect(permission.labelKey).toMatch(/^permissions\.[a-z_]+\.label$/);
      }
    }
  });
});
