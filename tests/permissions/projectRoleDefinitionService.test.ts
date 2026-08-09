import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import {
  grantablePermissionKeys,
  projectRoleDefinitionService,
} from '@/lib/services/projectRoleDefinitionService';
import { projectRoleDefinitionRepository } from '@/lib/repositories/projectRoleDefinitionRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  BuiltInRoleImmutableError,
  InvalidRoleNameError,
  InvalidRoleReassignTargetError,
  RoleDefinitionNotFoundError,
  RoleInUseError,
  RoleLimitReachedError,
  RoleNameTakenError,
  UngrantablePermissionError,
} from '@/lib/permissions/errors';
import { MAX_CUSTOM_ROLES_PER_PROJECT, MAX_ROLE_NAME_LENGTH } from '@/lib/permissions/limits';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// `projectRoleDefinitionService` (Story MOTIR-2257 · Subtask MOTIR-2472) against
// REAL Postgres. This is where the feature gets its JUDGEMENT: every rule about
// what a custom role may be lives in this one service, so that a route, a page
// and a future API client all get the same answers and none of them has to be
// trusted to remember a rule.
//
// The three worth reading rather than skimming, and each has its own describe:
//
//   * a role can only hold permissions the product genuinely ENFORCES, computed
//     from the catalog's own record rather than a list somebody typed;
//   * the CAP is a count-then-create, which is a race — so it locks, and the
//     test drives GENUINE concurrency rather than two sequential calls;
//   * DELETE refuses to strip anybody: the count comes back as a typed refusal
//     with nothing written, and the reassign-then-delete is one transaction.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  adminCtx: WorkspaceContext; // the workspace owner — always passes the rail
  memberCtx: WorkspaceContext; // a plain project member — never an admin
  memberUserId: string;
  otherUserId: string;
}

async function build(slug: string): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  async function projectActor(role: 'member' | 'viewer', tag: string) {
    const u = await usersService.createUser({
      email: `${tag}-${slug}@ex.com`,
      password: PASSWORD,
      name: tag,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return u;
  }
  const member = await projectActor('member', 'member');
  const other = await projectActor('viewer', 'other');

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    adminCtx: ownerCtx,
    memberCtx: { userId: member.id, workspaceId: workspace.id },
    memberUserId: member.id,
    otherUserId: other.id,
  };
}

/** Create a role through the service, with sane defaults. */
async function createRole(
  fx: Fixture,
  name: string,
  permissions: PermissionKey[] = ['project:browse'],
) {
  return projectRoleDefinitionService.create({
    projectId: fx.projectId,
    ctx: fx.adminCtx,
    name,
    permissions,
  });
}

describe('the gate — `project:manage_access`, and 404 before 403', () => {
  it('a project ADMIN (here the workspace owner) may create', async () => {
    const fx = await build('gate-ok');
    const role = await createRole(fx, 'Contractor', ['project:browse', 'comment:add']);
    expect(role.name).toBe('Contractor');
    expect(role.permissions).toEqual(['project:browse', 'comment:add']);
  });

  it('a plain project MEMBER is refused — PermissionDeniedError, the shape `project:manage_access` takes', async () => {
    const fx = await build('gate-member');
    await expect(
      projectRoleDefinitionService.create({
        projectId: fx.projectId,
        ctx: fx.memberCtx,
        name: 'Nope',
        permissions: [],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('a project in ANOTHER workspace raises ProjectNotFoundError, never a 403-shaped error', async () => {
    const mine = await build('gate-mine');
    const theirs = await build('gate-theirs');
    await expect(
      projectRoleDefinitionService.create({
        projectId: theirs.projectId,
        ctx: mine.adminCtx,
        name: 'Smuggled',
        permissions: [],
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    // And nothing was written.
    expect(await db.projectRoleDefinition.count({ where: { projectId: theirs.projectId } })).toBe(
      0,
    );
  });

  it('the gate runs on update, delete and findById too', async () => {
    const fx = await build('gate-all');
    const role = await createRole(fx, 'Contractor');
    await expect(
      projectRoleDefinitionService.update({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.memberCtx,
        name: 'Hijacked',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.memberCtx,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      projectRoleDefinitionService.findById(fx.projectId, role.id, fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('a permission no gate consults can never be granted', () => {
  it('refuses a key outside the ROLE-GATED set, naming the offender', async () => {
    const fx = await build('perm-outside');
    // A level-gated key: no role may hold one, ever.
    await expect(createRole(fx, 'Bad', ['public_request:submit' as PermissionKey])).rejects.toThrow(
      UngrantablePermissionError,
    );
    // A key that is not in the catalog at all.
    const err = await createRole(fx, 'Bad2', ['not:a:permission' as PermissionKey]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UngrantablePermissionError);
    expect((err as UngrantablePermissionError).key).toBe('not:a:permission');
    // A non-array body.
    await expect(
      projectRoleDefinitionService.create({
        projectId: fx.projectId,
        ctx: fx.adminCtx,
        name: 'Bad3',
        permissions: 'project:browse',
      }),
    ).rejects.toBeInstanceOf(UngrantablePermissionError);
  });

  it('THE CHECK READS `isEnforced`, proven with a SYNTHETIC non-enforced key', async () => {
    // The AC that matters: a hardcoded list would pass every other test in this
    // file and still be wrong the day a `planned` key is added. So drive the
    // derivation directly with a key the predicate reports as NOT enforced, and
    // show it is excluded — while every genuinely enforced key survives.
    const synthetic = 'synthetic:planned' as PermissionKey;
    const derived = grantablePermissionKeys(
      [...ROLE_GATED_PERMISSIONS, synthetic],
      (key) => key !== synthetic,
    );
    expect(derived.has(synthetic)).toBe(false);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(derived.has(key), `${key} was dropped`).toBe(true);
    }

    // And with today's real predicate — `PLANNED_PERMISSIONS` is empty on
    // `origin/main` — the grantable set IS the whole role-gated set, so the
    // check refuses nothing in practice today.
    expect([...grantablePermissionKeys()].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('every role-gated key IS accepted, so the guard is not over-broad', async () => {
    const fx = await build('perm-all');
    const role = await createRole(fx, 'Everything', [...ROLE_GATED_PERMISSIONS]);
    expect(role.permissions.sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('a duplicate key in the request is de-duplicated, not an error', async () => {
    const fx = await build('perm-dupe');
    const role = await createRole(fx, 'Dupes', ['project:browse', 'project:browse', 'comment:add']);
    expect(role.permissions).toEqual(['project:browse', 'comment:add']);
  });
});

describe('names — trimmed, bounded, unique WITHIN a project', () => {
  it('trims, and refuses empty / blank / over-long / non-string', async () => {
    const fx = await build('name-shape');
    expect((await createRole(fx, '  Contractor  ')).name).toBe('Contractor');
    await expect(createRole(fx, '')).rejects.toBeInstanceOf(InvalidRoleNameError);
    await expect(createRole(fx, '   ')).rejects.toBeInstanceOf(InvalidRoleNameError);
    await expect(createRole(fx, 'x'.repeat(MAX_ROLE_NAME_LENGTH + 1))).rejects.toBeInstanceOf(
      InvalidRoleNameError,
    );
    await expect(
      projectRoleDefinitionService.create({
        projectId: fx.projectId,
        ctx: fx.adminCtx,
        name: 42,
        permissions: [],
      }),
    ).rejects.toBeInstanceOf(InvalidRoleNameError);
  });

  it('a duplicate name raises RoleNameTakenError — NOT a raw P2002', async () => {
    const fx = await build('name-dupe');
    await createRole(fx, 'Contractor');
    const err = await createRole(fx, 'Contractor').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleNameTakenError);
    expect((err as RoleNameTakenError).code).toBe('ROLE_NAME_TAKEN');
    expect(String(err)).not.toContain('P2002');
  });

  it('a NON-P2002 database error propagates UNTRANSLATED — the catch is narrow', async () => {
    // The other half of the P2002 translation: it must name a duplicate name and
    // nothing else. A catch that swallowed every write failure into
    // RoleNameTakenError would report a connection loss as a naming conflict.
    const fx = await build('name-other-err');
    const role = await createRole(fx, 'Contractor');
    const boom = new Error('something else entirely');
    vi.spyOn(projectRoleDefinitionRepository, 'update').mockRejectedValueOnce(boom);
    await expect(
      projectRoleDefinitionService.rename({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        name: 'Renamed',
      }),
    ).rejects.toBe(boom);
  });

  it('the SAME name in a DIFFERENT project succeeds — a project`s roles are its own', async () => {
    const a = await build('name-proj-a');
    const b = await build('name-proj-b');
    await createRole(a, 'Contractor');
    const other = await createRole(b, 'Contractor');
    expect(other.name).toBe('Contractor');
  });

  it('a rename onto a taken name raises RoleNameTakenError too', async () => {
    const fx = await build('name-rename');
    await createRole(fx, 'Contractor');
    const second = await createRole(fx, 'Reporter');
    await expect(
      projectRoleDefinitionService.rename({
        projectId: fx.projectId,
        roleId: second.id,
        ctx: fx.adminCtx,
        name: 'Contractor',
      }),
    ).rejects.toBeInstanceOf(RoleNameTakenError);
  });
});

describe('a role is its NAME and its SET — nothing else is recorded', () => {
  // Yue, 2026-08-09. The editor still lets an author START FROM a built-in, but
  // that pick seeds the grid in the browser and is never sent. These assertions
  // are the guard against it creeping back: a role that carries provenance is a
  // role making a claim about its own history, which goes stale the moment
  // either side is edited.
  it('the DTO carries no `basedOn` and no derived delta', async () => {
    const fx = await build('no-base-dto');
    const role = await createRole(fx, 'Contractor', ['project:browse']);
    expect(role).toEqual({
      id: role.id,
      name: 'Contractor',
      permissions: ['project:browse'],
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    });
    expect('basedOn' in role).toBe(false);
  });

  it('a `basedOn` in the request is IGNORED, not stored and not echoed', async () => {
    // An old client (or a hand-rolled curl) can still send it. It must not
    // resurrect the column by the back door.
    const fx = await build('no-base-ignored');
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.adminCtx,
      name: 'Contractor',
      permissions: ['project:browse'],
      ...({ basedOn: 'admin' } as Record<string, unknown>),
    });
    expect('basedOn' in role).toBe(false);
    const stored = await db.projectRoleDefinition.findUniqueOrThrow({ where: { id: role.id } });
    expect('basedOn' in stored).toBe(false);
  });

  it('a rename and a re-permission change exactly those two things', async () => {
    const fx = await build('no-base-stable');
    const role = await createRole(fx, 'Contractor', ['project:browse']);
    const renamed = await projectRoleDefinitionService.update({
      projectId: fx.projectId,
      roleId: role.id,
      ctx: fx.adminCtx,
      name: 'External',
      permissions: ['project:browse', 'comment:add'],
    });
    expect(renamed.name).toBe('External');
    expect(renamed.permissions).toEqual(['project:browse', 'comment:add']);
    expect(renamed.id).toBe(role.id);
    expect(renamed.createdAt).toBe(role.createdAt);
  });
});

describe('the CAP holds under REAL concurrency', () => {
  it('firing MAX+1 creates simultaneously stores exactly the cap and refuses the surplus', async () => {
    const fx = await build('cap-race');
    const attempts = MAX_CUSTOM_ROLES_PER_PROJECT + 1;

    // Genuine concurrency against a warm pool — NOT `for … await`, which would
    // pass with no lock at all. The project row's FOR UPDATE is what serializes
    // the count-then-create; without it several of these read the same `n` and
    // the project ends up over its cap.
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) => createRole(fx, `Role ${i}`)),
    );

    const stored = await db.projectRoleDefinition.count({ where: { projectId: fx.projectId } });
    expect(stored).toBe(MAX_CUSTOM_ROLES_PER_PROJECT);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(MAX_CUSTOM_ROLES_PER_PROJECT);
    expect(rejected).toHaveLength(attempts - MAX_CUSTOM_ROLES_PER_PROJECT);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RoleLimitReachedError);
    }
  });

  it('a sequential create past the cap is refused with the typed error carrying the limit', async () => {
    const fx = await build('cap-seq');
    for (let i = 0; i < MAX_CUSTOM_ROLES_PER_PROJECT; i += 1) {
      await createRole(fx, `Role ${i}`);
    }
    const err = await createRole(fx, 'One too many').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleLimitReachedError);
    expect((err as RoleLimitReachedError).limit).toBe(MAX_CUSTOM_ROLES_PER_PROJECT);
  });

  it('the cap is PER PROJECT — a full project does not block its sibling', async () => {
    const a = await build('cap-a');
    const b = await build('cap-b');
    for (let i = 0; i < MAX_CUSTOM_ROLES_PER_PROJECT; i += 1) await createRole(a, `Role ${i}`);
    await expect(createRole(a, 'Overflow')).rejects.toBeInstanceOf(RoleLimitReachedError);
    expect((await createRole(b, 'Fine')).name).toBe('Fine');
  });
});

describe('a built-in is not a row and cannot be edited', () => {
  it('rename / setPermissions / delete on a built-in name are refused as IMMUTABLE, not not-found', async () => {
    const fx = await build('builtin');
    for (const builtIn of ['admin', 'member', 'viewer', 'owner']) {
      // The identifier arrives as an untrusted string, exactly as it would from
      // `DELETE /roles/admin`.
      await expect(
        projectRoleDefinitionService.update({
          projectId: fx.projectId,
          roleId: builtIn,
          ctx: fx.adminCtx,
          name: 'Hijacked',
        }),
      ).rejects.toBeInstanceOf(BuiltInRoleImmutableError);
      await expect(
        projectRoleDefinitionService.setPermissions({
          projectId: fx.projectId,
          roleId: builtIn,
          ctx: fx.adminCtx,
          permissions: [],
        }),
      ).rejects.toBeInstanceOf(BuiltInRoleImmutableError);
      await expect(
        projectRoleDefinitionService.delete({
          projectId: fx.projectId,
          roleId: builtIn,
          ctx: fx.adminCtx,
        }),
      ).rejects.toBeInstanceOf(BuiltInRoleImmutableError);
    }
  });

  it('a role belonging to ANOTHER project is not-found, not a cross-project write', async () => {
    const a = await build('cross-a');
    const b = await build('cross-b');
    const theirs = await createRole(b, 'Theirs');
    await expect(
      projectRoleDefinitionService.update({
        projectId: a.projectId,
        roleId: theirs.id,
        ctx: a.adminCtx,
        name: 'Stolen',
      }),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);
    expect((await db.projectRoleDefinition.findUnique({ where: { id: theirs.id } }))?.name).toBe(
      'Theirs',
    );
  });
});

describe('DELETE refuses to strip anybody', () => {
  /** Put `userId` on `roleId` through the only sanctioned write path. */
  async function hold(fx: Fixture, userId: string, roleId: string, base: 'viewer' | 'member') {
    await db.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        userId,
        fx.projectId,
        { roleDefinitionId: roleId, role: base },
        tx,
      ),
    );
  }

  it('a role nobody holds deletes cleanly', async () => {
    const fx = await build('del-empty');
    const role = await createRole(fx, 'Unheld');
    await projectRoleDefinitionService.delete({
      projectId: fx.projectId,
      roleId: role.id,
      ctx: fx.adminCtx,
    });
    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('with holders and NO destination: RoleInUseError carrying the count, and NOTHING is written', async () => {
    const fx = await build('del-inuse');
    const role = await createRole(fx, 'Contractor');
    await hold(fx, fx.memberUserId, role.id, 'viewer');
    await hold(fx, fx.otherUserId, role.id, 'viewer');

    const err = await projectRoleDefinitionService
      .delete({ projectId: fx.projectId, roleId: role.id, ctx: fx.adminCtx })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleInUseError);
    expect((err as RoleInUseError).count).toBe(2);
    expect((err as RoleInUseError).roleName).toBe('Contractor');

    // Nothing written: the role survives and both holders still hold it.
    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).not.toBeNull();
    expect(await db.projectMembership.count({ where: { roleDefinitionId: role.id } })).toBe(2);
  });

  it('with a destination: every holder MOVES and the role is removed, in one transaction', async () => {
    const fx = await build('del-reassign');
    const role = await createRole(fx, 'Contractor', ['project:browse']);
    const destination = await createRole(fx, 'Reporter', ['project:browse']);
    await hold(fx, fx.memberUserId, role.id, 'viewer');
    await hold(fx, fx.otherUserId, role.id, 'viewer');

    await projectRoleDefinitionService.delete({
      projectId: fx.projectId,
      roleId: role.id,
      ctx: fx.adminCtx,
      reassignTo: destination.id,
    });

    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).toBeNull();
    const moved = await db.projectMembership.findMany({
      where: { projectId: fx.projectId, roleDefinitionId: destination.id },
    });
    expect(moved).toHaveLength(2);
    // Both columns landed consistent — `role` is the DESTINATION's base, never
    // the old role's leftover value.
    for (const m of moved) expect(m.role).toBe('member');
  });

  it('a BUILT-IN destination clears the pointer and sets `role` to it', async () => {
    const fx = await build('del-to-builtin');
    const role = await createRole(fx, 'Contractor');
    await hold(fx, fx.memberUserId, role.id, 'viewer');

    await projectRoleDefinitionService.delete({
      projectId: fx.projectId,
      roleId: role.id,
      ctx: fx.adminCtx,
      reassignTo: 'member',
    });

    const survivor = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: fx.memberUserId, projectId: fx.projectId } },
    });
    expect(survivor?.roleDefinitionId).toBeNull();
    expect(survivor?.role).toBe('member');
  });

  it('a failure injected AFTER the reassign leaves BOTH the memberships and the role unchanged', async () => {
    // The transactional guarantee, driven rather than asserted from the code: if
    // the delete blows up after the move, nobody may be left holding a role that
    // still exists but no longer describes them.
    const fx = await build('del-atomic');
    const role = await createRole(fx, 'Contractor');
    const destination = await createRole(fx, 'Reporter', ['project:browse']);
    await hold(fx, fx.memberUserId, role.id, 'viewer');

    const boom = new Error('injected after the reassign');
    vi.spyOn(projectRoleDefinitionRepository, 'delete').mockRejectedValueOnce(boom);

    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        reassignTo: destination.id,
      }),
    ).rejects.toBe(boom);

    // Rolled back: the role is still there and the holder never moved.
    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).not.toBeNull();
    const untouched = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: fx.memberUserId, projectId: fx.projectId } },
    });
    expect(untouched?.roleDefinitionId).toBe(role.id);
    expect(untouched?.role).toBe('viewer');
  });

  it('a destination that is the role itself, or another project`s, is refused BEFORE any write', async () => {
    const fx = await build('del-target-a');
    const other = await build('del-target-b');
    const role = await createRole(fx, 'Contractor');
    const foreign = await createRole(other, 'Foreign');
    await hold(fx, fx.memberUserId, role.id, 'viewer');

    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        reassignTo: role.id,
      }),
    ).rejects.toBeInstanceOf(InvalidRoleReassignTargetError);

    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        reassignTo: foreign.id,
      }),
    ).rejects.toBeInstanceOf(InvalidRoleReassignTargetError);

    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        reassignTo: 'no-such-role',
      }),
    ).rejects.toBeInstanceOf(InvalidRoleReassignTargetError);

    // Untouched throughout.
    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).not.toBeNull();
    expect(await db.projectMembership.count({ where: { roleDefinitionId: role.id } })).toBe(1);
  });

  it('an illegal destination on an UNHELD role is still refused, not silently ignored', async () => {
    const fx = await build('del-unheld-target');
    const other = await build('del-unheld-other');
    const role = await createRole(fx, 'Unheld');
    const foreign = await createRole(other, 'Foreign');
    await expect(
      projectRoleDefinitionService.delete({
        projectId: fx.projectId,
        roleId: role.id,
        ctx: fx.adminCtx,
        reassignTo: foreign.id,
      }),
    ).rejects.toBeInstanceOf(InvalidRoleReassignTargetError);
    expect(await db.projectRoleDefinition.findUnique({ where: { id: role.id } })).not.toBeNull();
  });
});

describe('findById reads back what was written', () => {
  it('returns the role, and not-found for an unknown or foreign id', async () => {
    const fx = await build('find');
    const other = await build('find-other');
    const role = await createRole(fx, 'Contractor', ['project:browse', 'comment:add']);
    const read = await projectRoleDefinitionService.findById(fx.projectId, role.id, fx.adminCtx);
    expect(read).toEqual(role);

    await expect(
      projectRoleDefinitionService.findById(fx.projectId, 'nope', fx.adminCtx),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);
    const foreign = await createRole(other, 'Foreign');
    await expect(
      projectRoleDefinitionService.findById(fx.projectId, foreign.id, fx.adminCtx),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);
  });

  it('the DTO is serialisable and its permission list is in CATALOG order', async () => {
    const fx = await build('dto');
    // Deliberately posted out of catalog order.
    const role = await createRole(fx, 'Contractor', ['comment:add', 'project:browse']);
    expect(JSON.parse(JSON.stringify(role))).toEqual(role);
    expect(role.permissions).toEqual(['project:browse', 'comment:add']);
    expect(typeof role.createdAt).toBe('string');
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
