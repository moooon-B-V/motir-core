import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { resolvePermissions } from '@/lib/permissions/resolve';
import type { ProjectPermissionInputs } from '@/lib/permissions/resolve';
import { canViewLessons, canManageLessons, canManageProject } from '@/lib/projects/access';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import {
  ENFORCED_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CATALOG,
  PLANNED_PERMISSIONS,
  permissionsByDomain,
} from '@/lib/permissions/catalog';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { GRANTABLE_PERMISSIONS, UNGRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';

// THE LESSON LIBRARY KEYS (Subtask MOTIR-3336 · Story MOTIR-3329).
//
// Two keys, not one, and not three. The whole card is a granularity decision,
// so what is asserted here is the decision rather than the diff:
//
//   * `lesson:view` and `lesson:manage` are SEPARATE — a role that may read and
//     not change is expressible. That is the case the card exists for, and the
//     only way to prove it is to build such a role and check it resolves.
//   * `lesson:manage` covers the LIBRARY. Its name carries no verb that a
//     second caller would have to widen — asserted as a property of the key
//     string, because "do not call it `…:retire`" is otherwise a comment
//     somebody deletes.
//   * Neither key is `project:administer` in disguise: admin holds both today,
//     but they resolve through their own keys, so a custom role can withhold
//     one without withholding project administration.

const VIEW_KEY: PermissionKey = 'lesson:view';
const MANAGE_KEY: PermissionKey = 'lesson:manage';

const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];
const ROLES: (MemberRole | null)[] = [null, 'viewer', 'member', 'admin'];

function inputs(over: Partial<ProjectPermissionInputs>): ProjectPermissionInputs {
  return { accessLevel: 'private', workspaceRole: 'member', projectRole: 'admin', ...over };
}

describe('the catalog carries both keys, enforced, in the project domain', () => {
  it('each appears exactly once', () => {
    expect(PERMISSIONS.filter((k) => k === VIEW_KEY)).toHaveLength(1);
    expect(PERMISSIONS.filter((k) => k === MANAGE_KEY)).toHaveLength(1);
  });

  it('sets domain and enforcement consistently with the neighbouring project keys', () => {
    for (const key of [VIEW_KEY, MANAGE_KEY]) {
      expect(PERMISSION_CATALOG[key].domain).toBe(PERMISSION_CATALOG['project:browse'].domain);
      expect(PERMISSION_CATALOG[key].enforcement).toBe('enforced');
    }
  });

  it('leaves PLANNED_PERMISSIONS empty — the gate lands in the same change as the key', () => {
    // The shipped rule (MOTIR-2356 / MOTIR-3188), and the reason the predicates
    // in lib/projects/access.ts are part of THIS card rather than the route's:
    // there is no moment where the catalog advertises a key nothing resolves
    // through.
    expect([...PLANNED_PERMISSIONS]).toEqual([]);
    expect([...ENFORCED_PERMISSIONS].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('renders in a domain group rather than falling outside the grid', () => {
    const rendered = permissionsByDomain().flatMap((g) => g.permissions.map((p) => p.key));
    expect(rendered).toContain(VIEW_KEY);
    expect(rendered).toContain(MANAGE_KEY);
  });

  it('names the CHANGE key for the library, not for retiring', () => {
    // Retiring a lesson and adding one both take this key, so a name carrying
    // either verb would be wrong for the other caller the moment it arrives.
    expect(MANAGE_KEY).not.toMatch(/retire|delete|remove|disable|add|create/);
    expect(MANAGE_KEY.split(':')[0]).toBe(VIEW_KEY.split(':')[0]);
  });

  it('carries a label and a description in BOTH catalogs', () => {
    // Resolved through the catalog's OWN i18n keys rather than a hand-written
    // slug, so a change to `permissionSlug` cannot leave this passing against a
    // path the product no longer reads.
    for (const key of [VIEW_KEY, MANAGE_KEY]) {
      const { labelKey, descriptionKey } = PERMISSION_CATALOG[key];
      for (const [locale, catalog] of [
        ['en', en],
        ['zh', zh],
      ] as const) {
        for (const path of [labelKey, descriptionKey]) {
          const value = path
            .split('.')
            .reduce<unknown>(
              (node, part) =>
                node && typeof node === 'object'
                  ? (node as Record<string, unknown>)[part]
                  : undefined,
              catalog,
            );
          expect(typeof value, `${locale} is missing ${path}`).toBe('string');
          expect(String(value).trim(), `${locale}:${path} is blank`).not.toBe('');
        }
      }
    }
  });
});

describe('the built-in roles — admin gains both, nobody else gains either', () => {
  it('grants both to admin', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.admin.has(VIEW_KEY)).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.admin.has(MANAGE_KEY)).toBe(true);
  });

  it('grants NEITHER to member, viewer, or the implicit workspace-member set', () => {
    for (const key of [VIEW_KEY, MANAGE_KEY]) {
      expect(BUILTIN_ROLE_PERMISSIONS.member.has(key), `member must not hold ${key}`).toBe(false);
      expect(BUILTIN_ROLE_PERMISSIONS.viewer.has(key), `viewer must not hold ${key}`).toBe(false);
      expect(IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS.has(key)).toBe(false);
    }
  });

  it('is ROLE-gated, not LEVEL-gated — making a project public publishes no lessons', () => {
    for (const key of [VIEW_KEY, MANAGE_KEY]) {
      expect(ROLE_GATED_PERMISSIONS).toContain(key);
      expect(PUBLIC_PROJECT_PERMISSIONS).not.toContain(key);
    }
    // The case that would actually leak: an anonymous reader of a public project.
    const anonymous = inputs({ accessLevel: 'public', workspaceRole: null, projectRole: null });
    expect(canViewLessons(anonymous)).toBe(false);
    expect(canManageLessons(anonymous)).toBe(false);
  });

  it('reaches nobody a role did not put there, across every level × role combination', () => {
    for (const accessLevel of LEVELS) {
      for (const workspaceRole of ROLES) {
        for (const projectRole of ROLES) {
          const i = inputs({ accessLevel, workspaceRole, projectRole });
          const held = resolvePermissions(i);
          // The two rails: a workspace owner/admin always passes; a
          // non-workspace-member never does. Between them, only a project
          // `admin` holds these keys.
          const expected =
            workspaceRole !== null &&
            (workspaceRole === 'owner' || workspaceRole === 'admin' || projectRole === 'admin');
          expect(
            held.has(VIEW_KEY),
            `${accessLevel}/${workspaceRole}/${projectRole} lesson:view`,
          ).toBe(expected);
          expect(
            held.has(MANAGE_KEY),
            `${accessLevel}/${workspaceRole}/${projectRole} lesson:manage`,
          ).toBe(expected);
        }
      }
    }
  });
});

describe('the split earns its keep — read WITHOUT change is expressible', () => {
  it('a custom role holding only the view key reads and cannot change', () => {
    // The card's entire justification for two keys, stated as the role it makes
    // possible. With one key this test could not be written.
    const readOnly = inputs({
      workspaceRole: 'member',
      projectRole: 'member',
      customRolePermissions: ['project:browse', VIEW_KEY],
    });
    expect(canViewLessons(readOnly)).toBe(true);
    expect(canManageLessons(readOnly)).toBe(false);
  });

  it('a custom role holding neither key can still administer the project', () => {
    // And the converse of "do not reuse project:administer": the umbrella and
    // the lesson keys are independent, so withholding one withholds nothing else.
    const admin = inputs({
      workspaceRole: 'member',
      projectRole: 'member',
      customRolePermissions: ['project:browse', 'project:administer'],
    });
    expect(canManageProject(admin)).toBe(true);
    expect(canViewLessons(admin)).toBe(false);
    expect(canManageLessons(admin)).toBe(false);
  });
});

describe('no token surface gains them by accident', () => {
  it('neither key is grantable to an API token — no tool takes one yet', () => {
    for (const key of [VIEW_KEY, MANAGE_KEY]) {
      expect(GRANTABLE_PERMISSIONS).not.toContain(key);
      expect(UNGRANTABLE_PERMISSIONS).toContain(key);
    }
  });
});
