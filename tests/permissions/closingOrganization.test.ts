import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { CLOSING_READ_SET, resolvePermissions } from '@/lib/permissions/resolve';

// A CLOSING organization is read-only (Story MOTIR-6306 · MOTIR-6396;
// `docs/decisions/organization-deletion.md` §3) — the pure half: the resolver's
// intersection, over every input the parity table enumerates plus custom roles.

const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];
const ROLES: Array<MemberRole | null> = [null, 'owner', 'admin', 'member', 'viewer'];
const CUSTOM: Array<readonly string[] | null> = [
  null,
  [],
  ['project:browse', 'work_item:edit', 'comment:add', 'work_item:delete'],
];

function* allInputs() {
  for (const accessLevel of LEVELS)
    for (const workspaceRole of ROLES)
      for (const projectRole of ROLES)
        for (const customRolePermissions of CUSTOM)
          yield { accessLevel, workspaceRole, projectRole, customRolePermissions };
}

describe('the closing read set', () => {
  it('is the built-in viewer set — derived, so a new write key is closed by default', () => {
    expect([...CLOSING_READ_SET].sort()).toEqual([...BUILTIN_ROLE_PERMISSIONS.viewer].sort());
    for (const key of CLOSING_READ_SET) {
      expect(key).not.toMatch(/:(edit|add|create|delete|archive|manage|administer|submit)/);
    }
  });
});

describe('resolvePermissions with organizationClosing', () => {
  it('never returns a key outside the actor’s normal set, nor outside the read set', () => {
    for (const input of allInputs()) {
      const open = resolvePermissions(input);
      const closing = resolvePermissions({ ...input, organizationClosing: true });
      for (const key of closing) {
        expect(open.has(key), `${JSON.stringify(input)} gained ${key}`).toBe(true);
        expect(CLOSING_READ_SET.has(key), `${JSON.stringify(input)} kept ${key}`).toBe(true);
      }
      // …and is exactly the intersection: nothing readable is taken away.
      const expected = [...open].filter((k) => CLOSING_READ_SET.has(k)).sort();
      expect([...closing].sort()).toEqual(expected);
    }
  });

  it('leaves every actor who could browse still browsing, and nobody editing', () => {
    for (const input of allInputs()) {
      const open = resolvePermissions(input);
      const closing = resolvePermissions({ ...input, organizationClosing: true });
      expect(closing.has('project:browse')).toBe(open.has('project:browse'));
      expect(closing.has('work_item:edit')).toBe(false);
      expect(closing.has('comment:add')).toBe(false);
      expect(closing.has('attachment:create')).toBe(false);
    }
  });

  it('closes the Owner too, and a public visitor’s request writes', () => {
    const owner = resolvePermissions({
      accessLevel: 'open',
      workspaceRole: 'owner',
      projectRole: null,
      organizationClosing: true,
    });
    // Every key the Owner keeps is a READ key of the viewer set — derived rather
    // than listed, so a read key main adds to the viewer set (`approval:view_any`,
    // `plan:view_any`, `run:view_any` arrived that way) is kept, never a write.
    expect([...owner].sort()).toEqual(
      [...BUILTIN_ROLE_PERMISSIONS.viewer].filter((k) => owner.has(k)).sort(),
    );
    expect(owner.has('project:browse')).toBe(true);
    expect(owner.has('report:view')).toBe(true);
    for (const key of owner) {
      expect(key).not.toMatch(/:(edit|add|create|delete|archive|manage|administer|submit)/);
    }
    const visitor = resolvePermissions({
      accessLevel: 'public',
      workspaceRole: null,
      projectRole: null,
      organizationClosing: true,
    });
    // A public visitor keeps the browse, and whatever other READ keys their
    // open set holds — never a write (their request-submission key is gone).
    expect(visitor.has('project:browse')).toBe(true);
    for (const key of visitor) {
      expect(CLOSING_READ_SET.has(key)).toBe(true);
      expect(key).not.toMatch(/:(edit|add|create|delete|archive|manage|administer|submit)/);
    }
  });

  it('is unchanged when the flag is false or absent', () => {
    for (const input of allInputs()) {
      const absent = [...resolvePermissions(input)].sort();
      expect([...resolvePermissions({ ...input, organizationClosing: false })].sort()).toEqual(
        absent,
      );
    }
  });
});
