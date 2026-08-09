import { describe, expect, it } from 'vitest';
import {
  toBuiltinRoleDTO,
  toCustomRoleDTO,
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
    expect(dto.key).toBe('viewer');
    expect(dto.builtInRole).toBe('viewer');
    expect(dto.builtIn).toBe(true);
    expect(dto.labelKey).toBe('settings.roles.viewer.name');
    expect(dto.descriptionKey).toBe('settings.roles.viewer.description');
    expect([...dto.permissions].sort()).toEqual([...BUILTIN_ROLE_PERMISSIONS.viewer].sort());
  });
});

describe('toRoleCatalogDTO', () => {
  it('zero-fills a role nobody holds rather than omitting the key', () => {
    const catalog = toRoleCatalogDTO({ admin: 2 });
    expect(catalog.roles.map((r) => r.key)).toEqual([...PROJECT_ASSIGNABLE_ROLES]);
    expect(catalog.roles.find((r) => r.key === 'admin')?.memberCount).toBe(2);
    for (const role of catalog.roles) {
      expect(typeof role.memberCount, `${role.key} must carry a number`).toBe('number');
    }
    expect(catalog.roles.find((r) => r.key === 'member')?.memberCount).toBe(0);
    expect(catalog.roles.find((r) => r.key === 'viewer')?.memberCount).toBe(0);
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
    expect(catalog.roles.find((r) => r.key === 'admin')?.permissions.length).toBe(
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

// ── Custom roles (Story MOTIR-2257 · Subtask MOTIR-2478) ────────────────────

describe('toCustomRoleDTO', () => {
  const ROW = {
    id: 'role_contractor',
    name: 'Contractor',
    permissions: ['comment:add', 'project:browse', 'attachment:create'],
  };

  it('carries the literal name and NO i18n key — an author`s name is never translated', () => {
    const dto = toCustomRoleDTO(ROW, 4);
    expect(dto.key).toBe('role_contractor');
    expect(dto.name).toBe('Contractor');
    expect(dto.labelKey).toBeNull();
    expect(dto.descriptionKey).toBeNull();
    expect(dto.builtIn).toBe(false);
    expect(dto.memberCount).toBe(4);
  });

  it('`builtInRole` is NULL — so a `Record<ProjectRole, …>` is never indexed with a cuid', () => {
    expect(toCustomRoleDTO(ROW, 0).builtInRole).toBeNull();
  });

  it('records NOTHING about which built-in seeded it (Yue, 2026-08-09)', () => {
    // The editor still offers a "Start from" pick; it seeds the grid in the
    // browser and never reaches the DTO. A role IS its name and its set.
    const dto = toCustomRoleDTO(ROW, 0);
    expect('basedOn' in dto).toBe(false);
    expect('basedOnDelta' in dto).toBe(false);
  });

  it('emits its permissions in CATALOG order, whatever order they were stored in', () => {
    const dto = toCustomRoleDTO(ROW, 0);
    const positions = dto.permissions.map((k) => PERMISSIONS.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect([...dto.permissions].sort()).toEqual(
      ['project:browse', 'comment:add', 'attachment:create'].sort(),
    );
  });

  it('a key retired from the catalog is neither counted nor shown', () => {
    const stale = toCustomRoleDTO(
      { ...ROW, permissions: ['project:browse', 'repository:connect', 'not:a:permission'] },
      0,
    );
    expect(stale.permissions).toEqual(['project:browse']);
  });
});

describe('toRoleCatalogDTO with a project`s own roles', () => {
  const rows = [
    { id: 'r_reporter', name: 'Reporter', permissions: ['project:browse'] },
    { id: 'r_contractor', name: 'Contractor', permissions: ['project:browse'] },
  ];

  it('puts the three built-ins FIRST, then the custom roles BY NAME — deterministically', () => {
    const catalog = toRoleCatalogDTO({}, rows, {});
    expect(catalog.roles.map((r) => r.key)).toEqual([
      ...PROJECT_ASSIGNABLE_ROLES,
      'r_contractor', // Contractor sorts before Reporter
      'r_reporter',
    ]);
    // And the order does NOT depend on the order the rows arrived in.
    expect(toRoleCatalogDTO({}, [...rows].reverse(), {}).roles.map((r) => r.key)).toEqual(
      catalog.roles.map((r) => r.key),
    );
  });

  it('zero-fills a custom role nobody holds, and reports the count it was given', () => {
    const catalog = toRoleCatalogDTO({}, rows, { r_contractor: 4 });
    expect(catalog.roles.find((r) => r.key === 'r_contractor')?.memberCount).toBe(4);
    expect(catalog.roles.find((r) => r.key === 'r_reporter')?.memberCount).toBe(0);
  });

  it('a project with NO custom roles returns EXACTLY what it returned before', () => {
    // The regression that matters: the widening must not change the shipped
    // answer for a project that has no roles of its own.
    expect(toRoleCatalogDTO({ admin: 2 }, [], {})).toEqual(toRoleCatalogDTO({ admin: 2 }));
  });

  it('`roleGatedPermissionCount` is unaffected by how many roles exist', () => {
    expect(toRoleCatalogDTO({}, rows, {}).roleGatedPermissionCount).toBe(
      toRoleCatalogDTO().roleGatedPermissionCount,
    );
  });
});
