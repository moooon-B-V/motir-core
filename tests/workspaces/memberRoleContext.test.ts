import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  ROLE_MIGRATION_PAGE_SIZE,
  roleMigrationReportService,
} from '@/lib/services/roleMigrationReportService';
import { NotAMemberError, WorkspaceRoleForbiddenError } from '@/lib/workspaces/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The server half of the workspace Members page's role surfaces (Story
// MOTIR-6168 · MOTIR-6465), against real Postgres: who may change roles (decided
// here, never by the client), which members the ORG makes a Manager, the custom
// roles the picker offers, and the Managers-only migration report — paged at 20,
// dismissed one row at a time, and absent for everyone else.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const user = (label: string) =>
  usersService.createUser({
    email: `mrc-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

async function build() {
  const founder = await user('founder');
  const { workspace } = await workspacesService.createWorkspace({
    name: `MRC ${seq++}`,
    ownerUserId: founder.id,
  });
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const viewer = await user('viewer');
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: workspace.id,
    role: 'viewer',
  });
  await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: workspace.id, name: 'Contractor', permissions: ['project:browse'] },
  });
  return { workspace, founder, member, viewer };
}

async function seedReport(workspaceId: string, userId: string, n: number) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await adminDb.roleMigrationReport.create({
      data: {
        workspaceId,
        userId,
        beforeJson: { workspaceRole: 'member', projects: [{ projectKey: 'PROD', role: 'viewer' }] },
        afterRole: 'viewer',
        reason: 'narrowest_kept',
        createdAt: new Date(t0 + i * 1000),
      },
    });
  }
}

describe('getMemberRoleContext', () => {
  it('a Manager may change roles; the org Owner is org-managed; the custom roles are listed', async () => {
    const fx = await build();
    const ctx = await workspacesService.getMemberRoleContext(fx.workspace.id, fx.founder.id);
    expect(ctx.canManageRoles).toBe(true);
    // The creator minted the org, so they are its Owner — locked at Manager.
    expect(ctx.orgManagedUserIds).toEqual([fx.founder.id]);
    expect(ctx.organizationName).toBeTruthy();
    expect(ctx.customRoles.map((r) => r.name)).toEqual(['Contractor']);
  });

  it('a Member or a Viewer may not; an org Admin is listed as org-managed too', async () => {
    const fx = await build();
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.workspace.organizationId, userId: fx.viewer.id },
      data: { role: 'admin' },
    });
    for (const u of [fx.member]) {
      expect(
        (await workspacesService.getMemberRoleContext(fx.workspace.id, u.id)).canManageRoles,
      ).toBe(false);
    }
    const asMember = await workspacesService.getMemberRoleContext(fx.workspace.id, fx.member.id);
    expect(asMember.orgManagedUserIds.sort()).toEqual([fx.founder.id, fx.viewer.id].sort());
  });

  it('someone outside the workspace is not-found', async () => {
    const fx = await build();
    const stranger = await user('stranger');
    await expect(
      workspacesService.getMemberRoleContext(fx.workspace.id, stranger.id),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });
});

describe('roleMigrationReportService — Managers only', () => {
  it('pages at 20 with the open total, newest first, naming the person', async () => {
    const fx = await build();
    await seedReport(fx.workspace.id, fx.member.id, ROLE_MIGRATION_PAGE_SIZE + 3);
    const first = await roleMigrationReportService.firstPageForViewer(
      fx.workspace.id,
      fx.founder.id,
    );
    expect(first?.entries).toHaveLength(20);
    expect(first?.total).toBe(23);
    expect(first?.entries[0]).toMatchObject({
      name: 'member',
      afterRole: 'viewer',
      reason: 'narrowest_kept',
      before: { workspaceRole: 'member', projects: [{ projectKey: 'PROD', role: 'viewer' }] },
    });
    const second = await roleMigrationReportService.listOpen(
      fx.workspace.id,
      fx.founder.id,
      first!.nextCursor,
    );
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first!.entries, ...second.entries].map((e) => e.id));
    expect(ids.size).toBe(23);
  });

  it('a dismissed row does not return, and a second dismiss is a no-op', async () => {
    const fx = await build();
    await seedReport(fx.workspace.id, fx.member.id, 2);
    const before = await roleMigrationReportService.listOpen(fx.workspace.id, fx.founder.id);
    const id = before.entries[0]!.id;
    expect(await roleMigrationReportService.dismiss(fx.workspace.id, fx.founder.id, id)).toBe(true);
    expect(await roleMigrationReportService.dismiss(fx.workspace.id, fx.founder.id, id)).toBe(
      false,
    );
    const after = await roleMigrationReportService.listOpen(fx.workspace.id, fx.founder.id);
    expect(after.total).toBe(1);
    expect(after.entries.map((e) => e.id)).not.toContain(id);
  });

  it('a row of ANOTHER workspace cannot be dismissed through this one', async () => {
    const mine = await build();
    const theirs = await build();
    await seedReport(theirs.workspace.id, theirs.member.id, 1);
    const [row] = await adminDb.roleMigrationReport.findMany({
      where: { workspaceId: theirs.workspace.id },
    });
    expect(
      await roleMigrationReportService.dismiss(mine.workspace.id, mine.founder.id, row!.id),
    ).toBe(false);
    expect(
      (await adminDb.roleMigrationReport.findUniqueOrThrow({ where: { id: row!.id } })).dismissedAt,
    ).toBeNull();
  });

  it('a non-Manager gets no page, and is refused the list and the dismiss', async () => {
    const fx = await build();
    await seedReport(fx.workspace.id, fx.member.id, 1);
    expect(
      await roleMigrationReportService.firstPageForViewer(fx.workspace.id, fx.member.id),
    ).toBeNull();
    await expect(
      roleMigrationReportService.listOpen(fx.workspace.id, fx.viewer.id),
    ).rejects.toBeInstanceOf(WorkspaceRoleForbiddenError);
    const [row] = await adminDb.roleMigrationReport.findMany({
      where: { workspaceId: fx.workspace.id },
    });
    await expect(
      roleMigrationReportService.dismiss(fx.workspace.id, fx.member.id, row!.id),
    ).rejects.toBeInstanceOf(WorkspaceRoleForbiddenError);
    const stranger = await user('stranger');
    await expect(
      roleMigrationReportService.listOpen(fx.workspace.id, stranger.id),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });
});
