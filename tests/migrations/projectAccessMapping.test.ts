import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { runMigrationFile, user } from './_workspaceRoleTenant';
import {
  nullAccessMode,
  relaxProjectAccessModeNotNull,
  restoreProjectAccessModeNotNull,
} from './_projectAccessModeNotNull';

// The access migration (Story MOTIR-6169 · Subtask MOTIR-6542), run over a
// fixture tenant exactly as `prisma migrate deploy` runs it: one script, one
// session. It maps each project's level to a mode, reports the people a
// `limited` project stops admitting, and refuses a mode that admits anyone the
// old level did not.
//
// The fixture: one project at each of the four levels, and
//   manager     — a workspace Manager, not added anywhere
//   orgAdmin    — an org Admin who is NOT a workspace member
//   orgAdminWs  — an org Admin who IS a workspace member (Member role), not added
//   addedMember — a Member added to the `limited` project
//   member      — a Member added nowhere
//   viewer      — a Viewer added to the `limited` project, not to the `private` one
//
// The viewer is ADDED to the `limited` project so that exactly one person — the
// plain Member — loses entry there, as the card's criterion counts; the rule's
// reach to a Viewer who was NOT added is pinned by its own case below.

const MIGRATION = '20260927000100_project_access_mapping';

beforeEach(async () => {
  await truncateAuthTables();
  // The mapping ran over NULL-mode projects; since MOTIR-6686 that state has to be
  // rebuilt by dropping the constraint (`_projectAccessModeNotNull.ts`).
  await relaxProjectAccessModeNotNull();
});

afterEach(async () => {
  // Truncate first: the never-wider case leaves a deliberately disagreeing row,
  // which the contract migration's agreement check would refuse.
  await truncateAuthTables();
  await restoreProjectAccessModeNotNull();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function tenant() {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org pam${n}`, slug: `pam-org-${n}` },
  });
  const ws = await adminDb.workspace.create({
    data: { name: `WS pam${n}`, slug: `pam-ws-${n}`, organizationId: org.id },
  });
  const project = async (level: 'open' | 'limited' | 'private' | 'public') => {
    const p = await adminDb.project.create({
      data: {
        name: level,
        slug: `pam-${level}-${n}`,
        identifier: `PAM${level.slice(0, 2).toUpperCase()}${n}`,
        workspaceId: ws.id,
        // legacy-access-level: the mapping migration of each legacy level is what this file tests.
        accessLevel: level,
      },
    });
    // The mapping ran over NULL-mode rows (`_projectAccessModeNotNull.ts`).
    await nullAccessMode(p.id);
    return p;
  };
  const projects = {
    open: await project('open'),
    limited: await project('limited'),
    private: await project('private'),
    public: await project('public'),
  };
  const people = {
    manager: (await user('pam-manager')).id,
    orgAdmin: (await user('pam-orgadmin')).id,
    orgAdminWs: (await user('pam-orgadminws')).id,
    addedMember: (await user('pam-added')).id,
    member: (await user('pam-member')).id,
    viewer: (await user('pam-viewer')).id,
  };
  // The legacy `role` is not seeded: the mapping reads it only as the fallback of
  // `COALESCE(workspace_role, role)`, and `workspace_role` is always set (NOT NULL
  // since MOTIR-6561; the column is `@ignore`d since MOTIR-6567).
  const wsMember = (userId: string, workspaceRole: 'manager' | 'member' | 'viewer') =>
    adminDb.workspaceMembership.create({
      data: { userId, workspaceId: ws.id, workspaceRole },
    });
  await wsMember(people.manager, 'manager');
  await wsMember(people.orgAdminWs, 'member');
  await wsMember(people.addedMember, 'member');
  await wsMember(people.member, 'member');
  await wsMember(people.viewer, 'viewer');
  for (const userId of [people.orgAdmin, people.orgAdminWs]) {
    await adminDb.organizationMembership.create({
      data: { organizationId: org.id, userId, role: 'admin' },
    });
  }
  for (const userId of [people.addedMember, people.viewer]) {
    await adminDb.projectMembership.create({
      data: { workspaceId: ws.id, projectId: projects.limited.id, userId },
    });
  }
  return { wsId: ws.id, projects, people };
}

async function projectRows(wsId: string) {
  return adminDb.project.findMany({
    where: { workspaceId: wsId },
    select: { identifier: true, accessLevel: true, accessMode: true },
    orderBy: { identifier: 'asc' },
  });
}

/** A digest of every row the migration may write, to prove a re-run writes none. */
async function digest(wsId: string): Promise<string> {
  const projects = await adminDb.project.findMany({
    where: { workspaceId: wsId },
    orderBy: { id: 'asc' },
  });
  const reports = await adminDb.roleMigrationReport.findMany({
    where: { workspaceId: wsId },
    orderBy: { id: 'asc' },
  });
  return JSON.stringify({ projects, reports });
}

async function memberships(wsId: string) {
  return adminDb.workspaceMembership.findMany({
    where: { workspaceId: wsId },
    orderBy: { id: 'asc' },
  });
}

describe('the mapping', () => {
  it('ends the four levels at workspace / members / members / public and leaves accessLevel alone', async () => {
    const t = await tenant();
    const before = await projectRows(t.wsId);
    await runMigrationFile(MIGRATION);
    const after = await projectRows(t.wsId);
    const modeOf = (id: string) => after.find((r) => r.identifier === id)!.accessMode;
    expect(modeOf(t.projects.open.identifier)).toBe('workspace');
    expect(modeOf(t.projects.limited.identifier)).toBe('members');
    expect(modeOf(t.projects.private.identifier)).toBe('members');
    expect(modeOf(t.projects.public.identifier)).toBe('public');
    expect(after.map((r) => [r.identifier, r.accessLevel])).toEqual(
      before.map((r) => [r.identifier, r.accessLevel]),
    );
  });

  it('writes exactly one project_access_lost row — for the Member not added to the limited project', async () => {
    const t = await tenant();
    await runMigrationFile(MIGRATION);
    const rows = await adminDb.roleMigrationReport.findMany({ where: { workspaceId: t.wsId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(t.people.member);
    expect(rows[0]!.reason).toBe('project_access_lost');
    expect(rows[0]!.afterRole).toBe('member');
    expect(rows[0]!.beforeJson).toEqual({
      projectKey: t.projects.limited.identifier,
      accessLevel: 'limited',
    });
  });

  it('reports a Viewer not added to the limited project too — every non-Manager who could view it', async () => {
    const t = await tenant();
    await adminDb.projectMembership.delete({
      where: { userId_projectId: { userId: t.people.viewer, projectId: t.projects.limited.id } },
    });
    await runMigrationFile(MIGRATION);
    const rows = await adminDb.roleMigrationReport.findMany({ where: { workspaceId: t.wsId } });
    expect(rows.map((r) => r.userId).sort()).toEqual([t.people.member, t.people.viewer].sort());
    expect(rows.find((r) => r.userId === t.people.viewer)!.afterRole).toBe('viewer');
    for (const excluded of [
      t.people.manager,
      t.people.orgAdmin,
      t.people.orgAdminWs,
      t.people.addedMember,
    ]) {
      expect(rows.some((r) => r.userId === excluded)).toBe(false);
    }
  });

  it('changes no workspace_membership row', async () => {
    const t = await tenant();
    const before = await memberships(t.wsId);
    await runMigrationFile(MIGRATION);
    expect(await memberships(t.wsId)).toEqual(before);
    expect(before.every((m) => m.accessScope === 'full')).toBe(true);
  });

  it('is IDEMPOTENT — a re-run over the migrated database changes no row', async () => {
    const t = await tenant();
    await runMigrationFile(MIGRATION);
    const first = await digest(t.wsId);
    await runMigrationFile(MIGRATION);
    expect(await digest(t.wsId)).toBe(first);
  });
});

describe('the never-wider check', () => {
  it('RAISES and names the pair when a mode admits someone the old level did not', async () => {
    const t = await tenant();
    // A `private` project whose mode was pre-set to `workspace`: every Full member
    // now enters a project only its added people (and Managers) could before.
    await adminDb.project.update({
      where: { id: t.projects.private.id },
      data: { accessMode: 'workspace' },
    });
    let message: string | null = null;
    try {
      await runMigrationFile(MIGRATION);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('MOTIR-6542');
    expect(message).toContain(`project ${t.projects.private.identifier} (private → workspace)`);
    expect(message).toContain(`user ${t.people.member}`);
    // The org Admin rail is left out of the comparison.
    expect(message).not.toContain(`user ${t.people.orgAdminWs}`);
    // The failed migration rolled back: nothing was mapped or reported.
    const rows = await projectRows(t.wsId);
    expect(rows.find((r) => r.identifier === t.projects.open.identifier)!.accessMode).toBeNull();
    expect(await adminDb.roleMigrationReport.count({ where: { workspaceId: t.wsId } })).toBe(0);
  });
});
