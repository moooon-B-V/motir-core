import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The workspace's STAND-IN principal (Story MOTIR-6168 · MOTIR-6462) — the
// member eighteen system writers stamp as reporter / actor. The lookup moved
// from "the oldest legacy `owner` row" to "the oldest MANAGER", and it has to
// return the same person wherever that owner row still holds the Manager role.

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

/** The old rule, verbatim: the oldest `role = 'owner'` row. */
async function oldOwnerRule(workspaceId: string) {
  return adminDb.workspaceMembership.findFirst({
    where: { workspaceId, role: 'owner' },
    orderBy: { createdAt: 'asc' },
  });
}

describe('findStandInManagerByWorkspace', () => {
  it('returns the same user the owner-only lookup did while the owner row exists — even beside an OLDER Manager', async () => {
    const founder = await user('founder');
    const admin = await user('admin');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Stand-in Co',
      ownerUserId: founder.id,
    });
    // A legacy admin row older than the founder's (NULL workspace role, so it
    // resolves as a Manager) — a pure oldest-Manager rule would pick it.
    await adminDb.workspaceMembership.create({
      data: {
        userId: admin.id,
        workspaceId: workspace.id,
        role: 'admin',
        createdAt: new Date('2000-01-01T00:00:00Z'),
      },
    });

    const picked = await standIn(workspace.id);
    expect(picked?.userId).toBe(founder.id);
    expect(picked?.userId).toBe((await oldOwnerRule(workspace.id))?.userId);
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
