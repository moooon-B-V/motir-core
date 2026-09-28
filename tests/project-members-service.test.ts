import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidAccessModeError,
  NotAProjectMemberError,
  PermissionDeniedError,
  ProjectNotFoundError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import { PublicAccessUnavailableError } from '@/lib/projects/errors';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { runAsCloudBuild } from './helpers/cloudBuild';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { setWorkspaceRoleFor } from './helpers/workspaceRoleFixtures';
import { truncateAuthTables } from './helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Service-layer tests for projectMembersService (Story 6.4 · Subtask 6.4.4) —
// the project membership + access management write path. Real Postgres, no DB
// mocks, the truncate helper resets between tests (it CASCADEs workspace →
// project → project_membership). Typed-error assertions use the real classes.
//
// Authorization model under test (roles live on the WORKSPACE since Story
// MOTIR-6168 — a project membership only says "added to this project"):
//   * a workspace Manager ALWAYS manages (no project membership needed);
//   * a workspace Member / Viewer cannot, on the project or not →
//     PermissionDeniedError naming the key (MOTIR-2295);
//   * an actor who cannot BROWSE the project → ProjectNotFoundError (404), on
//     the reads as well as the writes.
//
// Coverage: add (happy, no role + target-must-be-workspace-member + duplicate),
// the authorization matrix, remove (no last-admin guard + idempotent-404),
// set-access-level
// (open/limited/private + go-private member seeding + invalid level), list, and
// the no-existence-leak 404 on an unknown key.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project. The owner is the workspace OWNER (createWorkspace
// seeds the founder as `owner`), so they manage projects via the workspace-manager
// tier without any project membership row.
async function makeFixture(slug: string) {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, workspace, project, key: project.identifier, ownerCtx: ctx };
}

// Add a brand-new user to the workspace as a plain `member`, returning the user.
async function addWorkspaceMember(workspaceId: string, email: string, name = 'Member') {
  const user = await makeUser(email, name);
  await workspacesService.addMember({ userId: user.id, workspaceId, workspaceRole: 'member' });
  return user;
}

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

describe('addMember', () => {
  it('a workspace owner adds a workspace member and gets a DTO — with no role in it', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('add');
    const alice = await addWorkspaceMember(workspace.id, 'alice-add@example.com', 'Alice');

    const member = await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: alice.id,
    });

    // DTO shape: userId / name / email ONLY — never a raw Prisma row, and no
    // role: a project membership carries none since roles moved to the
    // workspace (Story MOTIR-6168 · MOTIR-6464).
    expect(Object.keys(member).sort()).toEqual(['email', 'name', 'userId']);
    expect(member.userId).toBe(alice.id);
    expect(member.name).toBe('Alice');
    expect(member.email).toBe('alice-add@example.com');

    const persisted = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectMembershipRepository.findByUserAndProject(alice.id, project.id, tx),
    );
    // No legacy role is written (MOTIR-6562); the pointer stays empty.
    expect(persisted?.roleDefinitionId).toBeNull();
    expect(persisted?.workspaceId).toBe(workspace.id);
  });

  it('rejects a target who is not a workspace member', async () => {
    const { key, owner, ownerCtx } = await makeFixture('target');
    const outsider = await makeUser('outsider@example.com');
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: outsider.id,
      }),
    ).rejects.toBeInstanceOf(TargetNotWorkspaceMemberError);
  });

  it('rejects a duplicate add with AlreadyProjectMemberError', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('dup');
    const carol = await addWorkspaceMember(workspace.id, 'carol-dup@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: carol.id,
    });
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: carol.id,
      }),
    ).rejects.toBeInstanceOf(AlreadyProjectMemberError);
  });

  it('404s on an unknown project key (no existence leak)', async () => {
    const { owner, ownerCtx, workspace } = await makeFixture('miss');
    const dave = await addWorkspaceMember(workspace.id, 'dave-miss@example.com');
    await expect(
      projectMembersService.addMember({
        key: 'NOPE',
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: dave.id,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('authorization — who may manage', () => {
  it('a workspace Manager can manage; a Member cannot, on the project or not', async () => {
    const { workspace, key } = await makeFixture('authz');
    const manager = await addWorkspaceMember(workspace.id, 'admin-authz@example.com', 'Adminy');
    const plain = await addWorkspaceMember(workspace.id, 'plain-authz@example.com', 'Plain');
    const target = await addWorkspaceMember(workspace.id, 'target-authz@example.com', 'Target');

    // The role that manages is the WORKSPACE's — a Manager, in every project.
    await setWorkspaceRoleFor(manager.id, workspace.id, 'manager');

    const added = await projectMembersService.addMember({
      key,
      actorUserId: manager.id,
      ctx: ctxFor(manager.id, workspace.id),
      targetUserId: target.id,
    });
    expect(added.userId).toBe(target.id);

    // A workspace Member cannot manage — the refusal names the key (MOTIR-2295).
    const fresh = await addWorkspaceMember(workspace.id, 'fresh-authz@example.com');
    const refused = await projectMembersService
      .addMember({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        targetUserId: fresh.id,
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PermissionDeniedError);
    expect((refused as PermissionDeniedError).permission).toBe('member:manage');

    // Being ADDED to the project grants nothing of its own: `target` is on it and
    // still cannot change how open it is — refused `project:manage_access`, not
    // `member:manage`: who is IN the project and how open it is are separate.
    const refusedAccess = await projectMembersService
      .setAccessLevel({
        key,
        actorUserId: target.id,
        ctx: ctxFor(target.id, workspace.id),
        level: 'private',
      })
      .catch((e: unknown) => e);
    expect(refusedAccess).toBeInstanceOf(PermissionDeniedError);
    expect((refusedAccess as PermissionDeniedError).permission).toBe('project:manage_access');
  });

  it('removeMember is refused on member:manage too', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('authz-keys');
    const target = await addWorkspaceMember(workspace.id, 'target-keys@example.com', 'Target');
    const plain = await addWorkspaceMember(workspace.id, 'plain-keys@example.com', 'Plain');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: target.id,
    });
    const err = await projectMembersService
      .removeMember({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        targetUserId: target.id,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('member:manage');
  });

  it('the workspace owner still passes on EVERY access level — the always-pass rail survives', async () => {
    for (const level of ['open', 'limited', 'private'] as const) {
      const { workspace, key, owner, ownerCtx } = await makeFixture(`rail-${level}`);
      await projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level,
      });
      const someone = await addWorkspaceMember(workspace.id, `rail-${level}@example.com`, 'Rail');
      const added = await projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: someone.id,
      });
      expect(added.userId, `owner blocked on a ${level} project`).toBe(someone.id);
      // …and the reads, which this card gated on `project:browse`.
      expect(
        (await projectMembersService.listMembers({ key, actorUserId: owner.id, ctx: ownerCtx }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await projectMembersService.getAccess({ key, actorUserId: owner.id, ctx: ownerCtx }))
          .accessMode,
      ).toBe(level === 'open' ? 'workspace' : 'members');
    }
  });

  it('a NON-BROWSER gets 404, not 403 — a private project stays invisible', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('authz-404');
    await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    // Added AFTER the project went private, so no auto-seeded project membership.
    const outsider = await addWorkspaceMember(workspace.id, 'outsider-404@example.com', 'Out');
    const outsiderCtx = ctxFor(outsider.id, workspace.id);
    const target = await addWorkspaceMember(workspace.id, 'target-404@example.com', 'Target');

    // The WRITE — the private assert this replaced returned 403 here; a project
    // the actor cannot browse must be indistinguishable from a missing one.
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: outsider.id,
        ctx: outsiderCtx,
        targetUserId: target.id,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // The READS — ungated before this card, so a workspace member who could not
    // browse a private project could still read its member list and its access
    // level. That hole is closed.
    await expect(
      projectMembersService.listMembers({ key, actorUserId: outsider.id, ctx: outsiderCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectMembersService.getAccess({ key, actorUserId: outsider.id, ctx: outsiderCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('removeMember', () => {
  it('removes a member and returns the removed DTO', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('remove');
    const frank = await addWorkspaceMember(workspace.id, 'frank-remove@example.com', 'Frank');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: frank.id,
    });
    const removed = await projectMembersService.removeMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: frank.id,
    });
    expect(removed.userId).toBe(frank.id);
    const gone = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectMembershipRepository.findByUserAndProject(frank.id, project.id, tx),
    );
    expect(gone).toBeNull();
  });

  it('404s (NotAProjectMember) when removing a non-member', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('remove-miss');
    const nobody = await addWorkspaceMember(workspace.id, 'nobody-remove@example.com');
    await expect(
      projectMembersService.removeMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: nobody.id,
      }),
    ).rejects.toBeInstanceOf(NotAProjectMemberError);
  });

  it('removes the last person who was a project admin — there is no last-admin guard', async () => {
    // The project admin retired with the project roles (MOTIR-6464): a legacy
    // `admin` row is only "added to this project" now, so nothing is stranded.
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('remove-lastadmin');
    const sole = await addWorkspaceMember(workspace.id, 'sole-remove@example.com');
    await adminDb.projectMembership.create({
      data: { workspaceId: workspace.id, projectId: project.id, userId: sole.id },
    });
    const removed = await projectMembersService.removeMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: sole.id,
    });
    expect(removed.userId).toBe(sole.id);
    expect(await adminDb.projectMembership.count({ where: { projectId: project.id } })).toBe(0);
  });
});

describe('setAccessLevel — the legacy adapter onto setAccessMode', () => {
  it('maps `limited` to Members only without seeding members', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('access-open');
    const res = await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'limited',
    });
    // `limited` and `private` both land at Members only (`role-model.md` Q1),
    // and the legacy column is written beside the mode as `private`.
    expect(res).toEqual({ key, accessMode: 'members', accessLevel: 'private' });
    const count = await adminDb.projectMembership.count({ where: { projectId: project.id } });
    expect(count).toBe(0);
  });

  // ── MOTIR-4035 — `public` is a CLOUD capability ────────────────────────────
  //
  // Vitest sets no `MOTIR_CLOUD`, so this whole file runs as a SELF-HOSTED
  // build. That makes the off-cloud arm the default one, which is the right way
  // round: it is the arm that has never existed.

  it('refuses `public` on a self-hosted build — the ENFORCEMENT point, not the UI', async () => {
    const { key, owner, ownerCtx } = await makeFixture('access-public-selfhost');
    await expect(
      projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level: 'public',
      }),
    ).rejects.toBeInstanceOf(PublicAccessUnavailableError);
  });

  it('…and writes NOTHING — no level change, no madePublicAt stamp', async () => {
    // A refusal that had already stamped `madePublicAt` would leave the project
    // dated into the square's "Recent" rank for a publish that never happened.
    const { key, owner, ownerCtx, project } = await makeFixture('access-public-nowrite');
    await expect(
      projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level: 'public',
      }),
    ).rejects.toBeInstanceOf(PublicAccessUnavailableError);
    const row = await adminDb.project.findUnique({ where: { id: project.id } });
    expect(row?.accessLevel).not.toBe('public');
    expect(row?.madePublicAt).toBeNull();
  });

  it('leaves open / limited / private alone — the gate is ONE level wide', async () => {
    // `open` / `limited` / `private` are how a self-hosted team shares work
    // inside its own workspace, which is what self-hosting is for.
    const { key, owner, ownerCtx } = await makeFixture('access-selfhost-others');
    for (const level of ['open', 'limited', 'private'] as const) {
      const res = await projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level,
      });
      expect(res.accessMode).toBe(level === 'open' ? 'workspace' : 'members');
    }
  });

  it('maps the refusal to 400, not 500 and not 404', async () => {
    // 400 rather than 404, and the difference is the SUBJECT: the public READ
    // surface is absent and answers 404 (there is no door); this route is
    // present and refuses ONE argument. A 404 here would tell a caller looking
    // at the project that it does not exist.
    const res = projectMemberErrorResponse(new PublicAccessUnavailableError());
    expect(res).not.toBeNull();
    expect(res?.status).toBe(400);
    expect(((await res?.json()) as { code: string }).code).toBe('PUBLIC_ACCESS_UNAVAILABLE');
  });

  it('rejects an invalid access level', async () => {
    const { key, owner, ownerCtx } = await makeFixture('access-bad');
    await expect(
      projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level: 'secret',
      }),
    ).rejects.toBeInstanceOf(InvalidAccessLevelError);
  });

  it('going private adds NOBODY — Members only means the people deliberately added', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('access-private');
    const m1 = await addWorkspaceMember(workspace.id, 'm1-private@example.com');
    await addWorkspaceMember(workspace.id, 'm2-private@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: m1.id,
    });

    const res = await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    expect(res).toEqual({ key, accessMode: 'members', accessLevel: 'private' });

    // Only the one person added by hand is on it — m2 and the owner are not seeded.
    const rows = await adminDb.projectMembership.findMany({ where: { projectId: project.id } });
    expect(rows.map((r) => r.userId)).toEqual([m1.id]);
  });
});

describe('setAccessMode (Story MOTIR-6169 · MOTIR-6544)', () => {
  it('switching to `members` writes both columns and leaves the project_membership rows exactly as they were', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('mode-members');
    const m1 = await addWorkspaceMember(workspace.id, 'm1-mode@example.com');
    await addWorkspaceMember(workspace.id, 'm2-mode@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: m1.id,
    });
    const before = await adminDb.projectMembership.findMany({
      where: { projectId: project.id },
      orderBy: { id: 'asc' },
    });

    const res = await projectMembersService.setAccessMode({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'members',
    });
    expect(res).toEqual({ key, accessMode: 'members', accessLevel: 'private' });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.accessMode).toBe('members');
    expect(row.accessLevel).toBe('private');
    expect(
      await adminDb.projectMembership.findMany({
        where: { projectId: project.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });

  it('switching back to `workspace` writes workspace / open', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('mode-workspace');
    await projectMembersService.setAccessMode({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'members',
    });
    const res = await projectMembersService.setAccessMode({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'workspace',
    });
    expect(res).toEqual({ key, accessMode: 'workspace', accessLevel: 'open' });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect([row.accessMode, row.accessLevel]).toEqual(['workspace', 'open']);
  });

  it('rejects an invalid mode before touching anything', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('mode-bad');
    await expect(
      projectMembersService.setAccessMode({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        mode: 'x',
      }),
    ).rejects.toBeInstanceOf(InvalidAccessModeError);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.accessMode).toBe('workspace');
    const mapped = projectMemberErrorResponse(new InvalidAccessModeError('x'));
    expect(mapped?.status).toBe(400);
  });

  it('refuses `public` on a self-hosted build', async () => {
    const { key, owner, ownerCtx } = await makeFixture('mode-public-selfhost');
    await expect(
      projectMembersService.setAccessMode({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        mode: 'public',
      }),
    ).rejects.toBeInstanceOf(PublicAccessUnavailableError);
  });

  it('a workspace Member without project:manage_access gets the typed 403 and changes nothing', async () => {
    const { workspace, key, project } = await makeFixture('mode-member-refused');
    const plain = await addWorkspaceMember(workspace.id, 'plain-mode@example.com');
    const err = await projectMembersService
      .setAccessMode({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        mode: 'members',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('project:manage_access');
    expect(projectMemberErrorResponse(err)?.status).toBe(403);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.accessMode).toBe('workspace');
  });
});

describe('previewAccessModeChange (Story MOTIR-6169 · MOTIR-6544)', () => {
  it('lists exactly the Full, non-Manager workspace members who were not added — with their role', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('preview');
    const added = await addWorkspaceMember(workspace.id, 'added-preview@example.com', 'Added');
    const loser = await addWorkspaceMember(workspace.id, 'loser-preview@example.com', 'Loser');
    const viewer = await addWorkspaceMember(workspace.id, 'viewer-preview@example.com', 'Viewer');
    await setWorkspaceRoleFor(viewer.id, workspace.id, 'viewer');
    const limited = await addWorkspaceMember(workspace.id, 'limited-preview@example.com', 'Lim');
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: limited.id, workspaceId: workspace.id } },
      data: { accessScope: 'limited' },
    });
    const manager = await addWorkspaceMember(workspace.id, 'mgr-preview@example.com', 'Mgr');
    await setWorkspaceRoleFor(manager.id, workspace.id, 'manager');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: added.id,
    });

    const losing = await projectMembersService.previewAccessModeChange({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'members',
    });
    // Not the owner / the Manager (the rail), not the added member, not the
    // Limited one (who already cannot enter a project they were not added to).
    expect(losing.map((p) => p.userId).sort()).toEqual([loser.id, viewer.id].sort());
    const byId = new Map(losing.map((p) => [p.userId, p]));
    expect(byId.get(loser.id)).toMatchObject({
      name: 'Loser',
      email: 'loser-preview@example.com',
      workspaceRole: 'member',
      customRoleName: null,
    });
    expect(byId.get(viewer.id)?.workspaceRole).toBe('viewer');
  });

  it('returns nobody for any target other than `members`', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('preview-other');
    await addWorkspaceMember(workspace.id, 'someone-preview@example.com');
    for (const mode of ['workspace', 'public']) {
      expect(
        await projectMembersService.previewAccessModeChange({
          key,
          actorUserId: owner.id,
          ctx: ownerCtx,
          mode,
        }),
      ).toEqual([]);
    }
  });

  it('is behind project:manage_access', async () => {
    const { workspace, key } = await makeFixture('preview-refused');
    const plain = await addWorkspaceMember(workspace.id, 'plain-preview@example.com');
    const err = await projectMembersService
      .previewAccessModeChange({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        mode: 'members',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('project:manage_access');
  });
});

describe('getAccess', () => {
  it('reads the project default access level (open)', async () => {
    const { key, owner, ownerCtx } = await makeFixture('get-access-default');
    const access = await projectMembersService.getAccess({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(access).toEqual({ key, accessMode: 'workspace', accessLevel: 'open' });
  });

  it('reflects a level set via setAccessLevel', async () => {
    const { key, owner, ownerCtx } = await makeFixture('get-access-private');
    await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    const access = await projectMembersService.getAccess({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(access.accessLevel).toBe('private');
  });

  it('404s on an unknown project key (no existence leak)', async () => {
    const { owner, ownerCtx } = await makeFixture('get-access-missing');
    await expect(
      projectMembersService.getAccess({ key: 'NOPE', actorUserId: owner.id, ctx: ownerCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('setAccessLevel on a CLOUD build (MOTIR-4035)', () => {
  runAsCloudBuild();

  it('accepts `public` and stamps madePublicAt on the transition INTO it', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('access-public-cloud');
    const res = await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'public',
    });
    expect(res.accessLevel).toBe('public');
    const row = await adminDb.project.findUnique({ where: { id: project.id } });
    expect(row?.accessLevel).toBe('public');
    expect(row?.madePublicAt).toBeInstanceOf(Date);
  });

  it('setAccessMode(`public`) lands at public / public and stamps madePublicAt; stopping lands at workspace / open', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('mode-public-cloud');
    const on = await projectMembersService.setAccessMode({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'public',
    });
    expect(on).toEqual({ key, accessMode: 'public', accessLevel: 'public' });
    const stamped = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stamped.madePublicAt).toBeInstanceOf(Date);
    const off = await projectMembersService.setAccessMode({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: 'workspace',
    });
    expect(off).toEqual({ key, accessMode: 'workspace', accessLevel: 'open' });
  });
});

describe('listMembers', () => {
  it('lists members ordered by createdAt asc', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('list');
    const first = await addWorkspaceMember(workspace.id, 'first-list@example.com', 'First');
    const second = await addWorkspaceMember(workspace.id, 'second-list@example.com', 'Second');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: first.id,
    });
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: second.id,
    });
    const members = await projectMembersService.listMembers({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(members.map((m) => m.userId)).toEqual([first.id, second.id]);
  });
});
