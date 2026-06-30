import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { MOTIR_SYSTEM_USER_EMAIL, MOTIR_SYSTEM_USER_NAME } from '@/lib/ai/systemPrincipal';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-1451 — the system-principal provisioning the seed adds (a SECOND helper
// alongside seedGenerationTestProject). Real Postgres (the seed-test convention).
// Pins the invariants the bug-filing route depends on: the principal exists, is
// a member of BOTH the meta workspace and project, is NON-loginnable (no
// credential Account), and is reused (not duplicated) across reseeds.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspaceAndProject(name: string, identifier: string) {
  const owner = await usersService.createUser({
    email: `owner-${name}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  return { owner, workspace, project };
}

describe('seedSystemPrincipal (MOTIR-1451)', () => {
  it('provisions a reserved system user enrolled in the meta workspace + project', async () => {
    const { workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { userId } = await seedSystemPrincipal({
      workspaceId: workspace.id,
      projectId: project.id,
    });

    const user = await db.user.findUnique({ where: { id: userId } });
    expect(user?.email).toBe(MOTIR_SYSTEM_USER_EMAIL);
    expect(user?.name).toBe(MOTIR_SYSTEM_USER_NAME);

    expect(
      await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspace.id),
    ).not.toBeNull();
    expect(
      await projectMembershipRepository.findByUserAndProject(userId, project.id),
    ).not.toBeNull();
  });

  it('creates a NON-loginnable principal — no credential Account row', async () => {
    const { workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { userId } = await seedSystemPrincipal({
      workspaceId: workspace.id,
      projectId: project.id,
    });
    expect(await db.account.count({ where: { userId } })).toBe(0);
  });

  it('does NOT enrol the principal in the org roster (infrastructure, not a member)', async () => {
    const { workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const org = await db.workspace.findUnique({
      where: { id: workspace.id },
      select: { organizationId: true },
    });
    const { userId } = await seedSystemPrincipal({
      workspaceId: workspace.id,
      projectId: project.id,
    });
    const orgMembership = await db.organizationMembership.findFirst({
      where: { organizationId: org!.organizationId, userId },
    });
    expect(orgMembership).toBeNull();
  });

  it('reuses the same global user across a reseed (email upsert — no duplicate, no collision)', async () => {
    // Reseed reality: the workspace is dropped + rebuilt, but the global system
    // user survives. Re-provisioning into a fresh workspace must reuse it.
    const first = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { userId: firstId } = await seedSystemPrincipal({
      workspaceId: first.workspace.id,
      projectId: first.project.id,
    });

    const second = await makeWorkspaceAndProject('moooon-next', 'MOTIR2');
    const { userId: secondId } = await seedSystemPrincipal({
      workspaceId: second.workspace.id,
      projectId: second.project.id,
    });

    expect(secondId).toBe(firstId);
    expect(await db.user.count({ where: { email: MOTIR_SYSTEM_USER_EMAIL } })).toBe(1);
    expect(
      await workspaceMembershipRepository.findByUserAndWorkspace(secondId, second.workspace.id),
    ).not.toBeNull();
  });
});
