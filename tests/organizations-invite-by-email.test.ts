import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  AlreadyOrgMemberError,
  OrgForbiddenError,
  OrgInviteeNotFoundError,
} from '@/lib/organizations/errors';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the 6.10.5 org-admin UI's "invite by email" backing —
// organizationsService.addMemberByEmail. Real Postgres, no mocks (the project
// rule). The exhaustive org matrix is 6.10.7; this locks the email→user resolve
// + the not-found / forbidden / duplicate branches the invite picker depends on.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

describe('organizationsService.addMemberByEmail', () => {
  it('adds an existing Motir user to the org with the chosen role', async () => {
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);

    await organizationsService.addMemberByEmail({
      organizationId,
      email: invitee.email,
      role: 'admin',
      actorUserId: owner.id,
    });

    const membership = await db.organizationMembership.findFirst({
      where: { organizationId, userId: invitee.id },
    });
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('admin');
  });

  it('resolves the email case-insensitively', async () => {
    const owner = await createTestUser();
    const invitee = await createTestUser({ email: 'sam@northwind.co' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);

    await organizationsService.addMemberByEmail({
      organizationId,
      email: 'SAM@Northwind.CO',
      role: 'member',
      actorUserId: owner.id,
    });

    const membership = await db.organizationMembership.findFirst({
      where: { organizationId, userId: invitee.id },
    });
    expect(membership).not.toBeNull();
  });

  it('throws OrgInviteeNotFoundError when no Motir account matches the email', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);

    await expect(
      organizationsService.addMemberByEmail({
        organizationId,
        email: 'nobody@example.com',
        role: 'member',
        actorUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(OrgInviteeNotFoundError);
  });

  it('throws AlreadyOrgMemberError when the user is already in the org', async () => {
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMemberByEmail({
      organizationId,
      email: invitee.email,
      role: 'member',
      actorUserId: owner.id,
    });

    await expect(
      organizationsService.addMemberByEmail({
        organizationId,
        email: invitee.email,
        role: 'member',
        actorUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(AlreadyOrgMemberError);
  });

  it('refuses a non-admin actor (the addMember org-admin gate)', async () => {
    const owner = await createTestUser();
    const plainMember = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    // plainMember joins the org as a plain member.
    await organizationsService.addMember({
      organizationId,
      userId: plainMember.id,
      role: 'member',
      actorUserId: owner.id,
    });

    await expect(
      organizationsService.addMemberByEmail({
        organizationId,
        email: invitee.email,
        role: 'member',
        actorUserId: plainMember.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });
});
