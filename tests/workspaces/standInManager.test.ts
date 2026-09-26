import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The workspace's STAND-IN principal (Story MOTIR-6168 · MOTIR-6462) — the
// member eighteen system writers stamp as reporter / actor. The rule is the
// OLDEST MANAGER by `createdAt` (then `id`). Since MOTIR-6561 the legacy `role`
// takes no part — it neither orders the pick nor stands in for a NULL workspace
// role — and because a founder's membership is written when the workspace is,
// the oldest Manager is the founder wherever the founder is still a Manager.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function user(tag: string) {
  return usersService.createUser({
    email: `stand-in-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Stand-in ${tag}`,
  });
}

/** The lookup as its callers make it — inside a transaction (the owner client here: RLS is not the subject). */
async function standIn(workspaceId: string) {
  return adminDb.$transaction((tx) =>
    workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx),
  );
}

describe('findStandInManagerByWorkspace', () => {
  it('returns the founder — the oldest Manager — when a later Manager joins', async () => {
    const founder = await user('founder');
    const later = await user('later');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Stand-in Co',
      ownerUserId: founder.id,
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: later.id,
        workspaceId: workspace.id,
        workspaceRole: 'manager',
        role: 'admin',
      },
    });

    const picked = await standIn(workspace.id);
    expect(picked?.userId).toBe(founder.id);
  });

  it('ignores the legacy role: an older row whose legacy role is `owner` but whose workspace role is Member is never picked', async () => {
    const founder = await user('founder-legacy');
    const legacyOwner = await user('legacy-owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Legacy Co',
      ownerUserId: founder.id,
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: legacyOwner.id,
        workspaceId: workspace.id,
        workspaceRole: 'member',
        role: 'owner',
        createdAt: new Date('2000-01-01T00:00:00Z'),
      },
    });

    const picked = await standIn(workspace.id);
    expect(picked?.userId).toBe(founder.id);
  });

  it('breaks a createdAt tie by id, so the pick is deterministic', async () => {
    const founder = await user('founder-tie');
    const a = await user('tie-a');
    const b = await user('tie-b');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Tie Co',
      ownerUserId: founder.id,
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: founder.id, workspaceId: workspace.id } },
      data: { workspaceRole: 'member' },
    });
    const at = new Date('2001-01-01T00:00:00Z');
    for (const u of [a, b]) {
      await adminDb.workspaceMembership.create({
        data: { userId: u.id, workspaceId: workspace.id, workspaceRole: 'manager', createdAt: at },
      });
    }
    const rows = await adminDb.workspaceMembership.findMany({
      where: { workspaceId: workspace.id, workspaceRole: 'manager' },
      orderBy: { id: 'asc' },
    });

    const picked = await standIn(workspace.id);
    expect(picked?.userId).toBe(rows[0]!.userId);
  });

  it('returns the oldest Manager once the owner row no longer holds the Manager role', async () => {
    const founder = await user('founder2');
    const older = await user('older');
    const newer = await user('newer');
    const viewer = await user('viewer');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Migrated Co',
      ownerUserId: founder.id,
    });
    // The founder was demoted to Member: the legacy column still says `owner`.
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: founder.id, workspaceId: workspace.id } },
      data: { workspaceRole: 'member' },
    });
    for (const [u, at, role] of [
      [viewer, '2001-01-01', 'viewer'],
      [older, '2002-01-01', 'manager'],
      [newer, '2003-01-01', 'manager'],
    ] as const) {
      await adminDb.workspaceMembership.create({
        data: {
          userId: u.id,
          workspaceId: workspace.id,
          role: 'member',
          workspaceRole: role,
          createdAt: new Date(`${at}T00:00:00Z`),
        },
      });
    }

    const picked = await standIn(workspace.id);
    expect(picked?.userId).toBe(older.id);
  });

  it('returns null for a workspace with no Manager at all', async () => {
    const founder = await user('founder3');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Leaderless Co',
      ownerUserId: founder.id,
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: founder.id, workspaceId: workspace.id } },
      data: { workspaceRole: 'viewer' },
    });
    expect(await standIn(workspace.id)).toBeNull();
  });
});
