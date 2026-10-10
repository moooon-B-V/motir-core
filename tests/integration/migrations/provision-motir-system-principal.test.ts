import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { MOTIR_SYSTEM_USER_EMAIL, MOTIR_SYSTEM_USER_NAME } from '@/lib/ai/systemPrincipal';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-8058 — the migration that provisions the Motir system principal in
// PRODUCTION, pinned to the meta project's production id. Production had no
// system user, so every service-bearer write from motir-ai was refused with
// `system_principal_not_provisioned`. Real Postgres; the SQL is replayed
// verbatim, as the deploy applies it.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261009210000_provision_motir_system_principal/migration.sql',
  ),
  'utf8',
);

/** The meta project's PRODUCTION id — the migration's only key. */
const META_PROJECT_ID = 'cmqfb4d8q000e2d0i6n62otyc';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A workspace with a `MOTIR`-keyed project. `pinned` re-ids that project to the
 *  production meta project's id; without it the project is a lookalike — the
 *  customer workspace that ALSO keys a project `MOTIR`. */
async function makeTenant(opts: { pinned: boolean }) {
  const n = seq++;
  const owner = await usersService.createUser({
    email: `pmsp-owner-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `ws-${n}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  let projectId = project.id;
  if (opts.pinned) {
    // Every FK onto `project.id` is ON UPDATE CASCADE, so the re-id carries the
    // project's statuses, folders and memberships with it.
    await adminDb.$executeRaw`UPDATE "project" SET "id" = ${META_PROJECT_ID} WHERE "id" = ${project.id}`;
    projectId = META_PROJECT_ID;
  }
  return { owner, workspace, projectId };
}

/** Replay the migration as the database OWNER — the deploy's role. */
const runAsOwner = () => adminDb.$executeRawUnsafe(MIGRATION_SQL);
/** Replay it as the NON-BYPASS runtime role, so the policies bite. */
const runAsAppRole = () => db.$executeRawUnsafe(MIGRATION_SQL);

async function principalState() {
  const users = await adminDb.user.findMany({ where: { email: MOTIR_SYSTEM_USER_EMAIL } });
  const userIds = users.map((u) => u.id);
  const [workspaceMemberships, projectMemberships, accounts, orgMemberships] = await Promise.all([
    adminDb.workspaceMembership.findMany({ where: { userId: { in: userIds } } }),
    adminDb.projectMembership.findMany({ where: { userId: { in: userIds } } }),
    adminDb.account.findMany({ where: { userId: { in: userIds } } }),
    adminDb.organizationMembership.findMany({ where: { userId: { in: userIds } } }),
  ]);
  return { users, workspaceMemberships, projectMemberships, accounts, orgMemberships };
}

describe('the migration and the code agree on the principal', () => {
  it('names the same email and the same display name as lib/ai/systemPrincipal.ts', () => {
    expect(MOTIR_SYSTEM_USER_NAME).toBe('Motir');
    expect(MIGRATION_SQL).toContain(`'${MOTIR_SYSTEM_USER_EMAIL}'`);
    expect(MIGRATION_SQL).toContain(`'${MOTIR_SYSTEM_USER_NAME}', true`);
    expect(MIGRATION_SQL).toContain(`'${META_PROJECT_ID}'`);
  });
});

describe('20261009210000_provision_motir_system_principal', () => {
  it('provisions the user and both memberships in the pinned project, and a re-run changes nothing', async () => {
    const { workspace, projectId } = await makeTenant({ pinned: true });

    await runAsOwner();
    const first = await principalState();

    expect(first.users).toHaveLength(1);
    expect(first.users[0]).toMatchObject({ name: 'Motir', emailVerified: true });
    expect(first.workspaceMemberships).toHaveLength(1);
    expect(first.workspaceMemberships[0]).toMatchObject({
      workspaceId: workspace.id,
      workspaceRole: 'member',
    });
    expect(first.projectMemberships).toHaveLength(1);
    expect(first.projectMemberships[0]).toMatchObject({ workspaceId: workspace.id, projectId });
    // No credential account: nothing to sign in with. No org roster row.
    expect(first.accounts).toHaveLength(0);
    expect(first.orgMemberships).toHaveLength(0);

    await runAsOwner();
    const second = await principalState();
    expect(second.users.map((u) => u.id)).toEqual(first.users.map((u) => u.id));
    expect(second.workspaceMemberships.map((m) => m.id)).toEqual(
      first.workspaceMemberships.map((m) => m.id),
    );
    expect(second.projectMemberships.map((m) => m.id)).toEqual(
      first.projectMemberships.map((m) => m.id),
    );
  });

  it('writes nothing where the pinned project does not exist — even beside a project keyed MOTIR', async () => {
    await makeTenant({ pinned: false });

    await runAsOwner();
    const state = await principalState();

    expect(state.users).toHaveLength(0);
    expect(state.workspaceMemberships).toHaveLength(0);
    expect(state.projectMemberships).toHaveLength(0);
  });

  it('provisions the same rows under the non-bypass runtime role, because it binds the GUCs itself', async () => {
    const { workspace, projectId } = await makeTenant({ pinned: true });

    await runAsAppRole();
    const state = await principalState();

    expect(state.users).toHaveLength(1);
    expect(state.workspaceMemberships.map((m) => m.workspaceId)).toEqual([workspace.id]);
    expect(state.projectMemberships.map((m) => m.projectId)).toEqual([projectId]);
  });

  it('renames a principal the seed already provisioned and adds no second membership', async () => {
    const { workspace, projectId } = await makeTenant({ pinned: true });
    // The pre-rename seed's shape: the same email, the old display name.
    const { userId } = await seedSystemPrincipal({ workspaceId: workspace.id, projectId });
    await adminDb.user.update({ where: { id: userId }, data: { name: 'Motir Planner' } });

    await runAsOwner();
    const state = await principalState();

    expect(state.users).toEqual([expect.objectContaining({ id: userId, name: 'Motir' })]);
    expect(state.workspaceMemberships).toHaveLength(1);
    expect(state.projectMemberships).toHaveLength(1);
  });

  it('leaves a principal that resolves, files a bug AS Motir, and stays off the org roster', async () => {
    const { owner, workspace, projectId } = await makeTenant({ pinned: true });

    await runAsOwner();

    const ctx = await resolveSystemPrincipal();
    expect(ctx.workspaceId).toBe(workspace.id);

    const bug = await workItemsService.createWorkItem(
      { projectId, kind: 'bug', title: 'A planning job failed' },
      ctx,
    );
    expect(bug.identifier).toMatch(/^MOTIR-\d+$/);
    const reporter = await adminDb.user.findUniqueOrThrow({ where: { id: bug.reporterId } });
    expect(reporter).toMatchObject({ email: MOTIR_SYSTEM_USER_EMAIL, name: 'Motir' });

    const roster = await organizationsService.listMembers({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    expect(roster.total).toBe(1);
    expect(roster.members.map((m) => m.userId)).toEqual([owner.id]);
  });
});
