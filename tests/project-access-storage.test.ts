import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { projectAccessData } from './helpers/projectAccess';
import type { ProjectAccessMode } from '@/generated/prisma/client';

// Schema + repository proof for the project access STORAGE (Story MOTIR-6169 ·
// Subtask MOTIR-6541) — the EXPAND step. It covers only what that card ships:
//
//   * `project.access_mode` backfills NULL at every legacy level — nothing is
//     migrated here, and there is no default to hand `workspace` to a project
//     the old build creates `private`;
//   * a `workspace_membership` inserted WITHOUT naming `access_scope` (the old
//     build's insert) reads `full`;
//   * `role_migration_reason` carries `project_access_lost`;
//   * `projectRepository.setAccessMode` writes BOTH columns in one update, and
//     the other repository leaves the card adds.
//
// Repository leaves ride the admin client, as `workspace-role-storage.test.ts`
// does: a policy denial would replace the signal with noise.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function tenant() {
  const n = seq++;
  const owner = await usersService.createUser({
    email: `pas-owner-${n}@example.com`,
    password: 'hunter2hunter2',
    name: `PAS Owner ${n}`,
  });
  const member = await usersService.createUser({
    email: `pas-member-${n}@example.com`,
    password: 'hunter2hunter2',
    name: `PAS Member ${n}`,
  });
  const ws = await workspacesService.createWorkspace({ name: `PAS ${n}`, ownerUserId: owner.id });
  return { owner: owner.id, member: member.id, workspaceId: ws.workspace.id };
}

async function project(workspaceId: string, mode: ProjectAccessMode) {
  const n = seq++;
  return adminDb.project.create({
    data: {
      name: `P ${mode}`,
      slug: `pas-${mode}-${n}`,
      identifier: `PAS${n}`,
      workspaceId,
      ...projectAccessData(mode),
    },
  });
}

async function unsetProject(workspaceId: string) {
  const n = seq++;
  return adminDb.project.create({
    data: { name: `P unset`, slug: `pas-unset-${n}`, identifier: `PAS${n}`, workspaceId },
  });
}

describe('the new columns, as the migration leaves them', () => {
  it('stores a project created naming neither column as workspace / open — the NOT NULL default (MOTIR-6686)', async () => {
    const t = await tenant();
    const p = await unsetProject(t.workspaceId);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.accessMode).toBe('workspace');
    expect(row.accessLevel).toBe('open');
  });

  it('reads access_scope `full` on a membership inserted without naming it', async () => {
    const t = await tenant();
    // The old build's insert: raw SQL that knows nothing of `access_scope`. It
    // names `workspace_role`, which is NOT NULL since MOTIR-6561.
    await adminDb.$executeRaw`
      INSERT INTO "workspace_membership" ("id", "userId", "workspaceId", "workspace_role", "updatedAt")
      VALUES ('pas-old-build-row', ${t.member}, ${t.workspaceId}, 'member', now())`;
    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: t.member, workspaceId: t.workspaceId } },
    });
    expect(row.accessScope).toBe('full');
  });

  it('adds project_access_lost to role_migration_reason', async () => {
    const rows = await adminDb.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'role_migration_reason'`;
    expect(rows.map((r) => r.enumlabel)).toContain('project_access_lost');
  });
});

describe('projectRepository.setAccessMode', () => {
  it.each([
    ['members', 'private'],
    ['public', 'public'],
    ['workspace', 'open'],
  ] as const)('writes access_mode = %s and access_level = %s together', async (mode, level) => {
    const t = await tenant();
    const p = await project(t.workspaceId, mode === 'workspace' ? 'members' : 'workspace');
    await adminDb.$transaction((tx) => projectRepository.setAccessMode(p.id, mode, tx));
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.accessMode).toBe(mode);
    expect(row.accessLevel).toBe(level);
  });

  it('stamps madePublicAt only when asked', async () => {
    const t = await tenant();
    const p = await project(t.workspaceId, 'workspace');
    await adminDb.$transaction((tx) => projectRepository.setAccessMode(p.id, 'public', tx));
    expect((await adminDb.project.findUniqueOrThrow({ where: { id: p.id } })).madePublicAt).toBe(
      null,
    );
    await adminDb.$transaction((tx) =>
      projectRepository.setAccessMode(p.id, 'public', tx, { stampMadePublicAt: true }),
    );
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: p.id } })).madePublicAt,
    ).toBeInstanceOf(Date);
  });
});

describe('workspaceMembershipRepository.setAccessScope', () => {
  it('writes the scope on the (user, workspace) row and leaves the role alone', async () => {
    const t = await tenant();
    await adminDb.workspaceMembership.create({
      data: {
        userId: t.member,
        workspaceId: t.workspaceId,
        role: 'member',
        workspaceRole: 'member',
      },
    });
    const updated = await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setAccessScope(t.member, t.workspaceId, 'limited', tx),
    );
    expect(updated.accessScope).toBe('limited');
    expect(updated.workspaceRole).toBe('member');
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setAccessScope(t.member, t.workspaceId, 'full', tx),
    );
    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: t.member, workspaceId: t.workspaceId } },
    });
    expect(row.accessScope).toBe('full');
  });
});

describe('projectMembershipRepository — who was added', () => {
  it('counts and lists the people added to one project only', async () => {
    const t = await tenant();
    const p1 = await project(t.workspaceId, 'members');
    const p2 = await project(t.workspaceId, 'members');
    for (const userId of [t.owner, t.member]) {
      await adminDb.projectMembership.create({
        data: { workspaceId: t.workspaceId, projectId: p1.id, userId, role: 'member' },
      });
    }
    await adminDb.projectMembership.create({
      data: { workspaceId: t.workspaceId, projectId: p2.id, userId: t.owner, role: 'member' },
    });
    const [count1, ids1, count2, ids2] = await adminDb.$transaction(async (tx) => [
      await projectMembershipRepository.countByProject(p1.id, tx),
      await projectMembershipRepository.findUserIdsByProject(p1.id, tx),
      await projectMembershipRepository.countByProject(p2.id, tx),
      await projectMembershipRepository.findUserIdsByProject(p2.id, tx),
    ]);
    expect(count1).toBe(2);
    expect(ids1).toEqual([t.owner, t.member].sort());
    expect(count2).toBe(1);
    expect(ids2).toEqual([t.owner]);
  });
});
