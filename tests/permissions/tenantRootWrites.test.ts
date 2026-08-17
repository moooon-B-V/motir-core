import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// The TENANT-ROOT write paths, exercised end to end (MOTIR-2868).
//
// These are the writes that CREATE the tenancy the RLS policies are defined in
// terms of, so they carry a circularity none of the other write paths have: a
// membership row cannot be written under a context bound to a workspace the
// actor is not a member of yet. The DB half of the answer is the tenant-root
// INSERT policies (MOTIR-2512) — `workspace_insert_bootstrap`,
// `organization_insert_bootstrap`, and the `_insert_active_or_bootstrap`
// membership pair — which key on the caller-chosen SLUG rather than on an id
// that does not exist until the statement runs.
//
// ⚠️ Every assertion here reads the row back through the SHIPPED SERVICE, never
// through `adminDb`. Under the owner client a row is visible whether or not any
// policy admits it, so an owner-client assertion proves the INSERT happened and
// says nothing about whether the application could have made it or could see the
// result. `adminDb` appears in this file exactly once, to plant an invite token
// the flow has no service read for.
//
// Under `TEST_DB_APP_ROLE=1` on `origin/main` the org case is RED (the
// `createOrganization` transaction bound nothing); the workspace and invite
// cases are the regression cover for bindings that already exist and had no
// test asserting the bound READ-BACK.

let emailEvents: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  emailEvents = captureEmailEvents();
});

afterAll(async () => {
  emailEvents?.restore();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string, name: string) {
  return usersService.createUser({ email, password: 'hunter2hunter2', name });
}

describe('tenant-root writes under the restricted runtime role', () => {
  it('createWorkspace writes the owner membership, and the app can read it back', async () => {
    const owner = await makeUser('root-owner@example.com', 'Root Owner');

    const { workspace, membership } = await workspacesService.createWorkspace({
      name: 'Bootstrap Co',
      ownerUserId: owner.id,
    });
    expect(membership.role).toBe('owner');

    // The bound read: `listMembers` runs under withWorkspaceContext, so it sees
    // the row only if the membership INSERT and its RETURNING both passed.
    const members = await workspacesService.listMembers(workspace.id, owner.id);
    expect(members.map((m) => m.userId)).toEqual([owner.id]);
    expect(members[0]!.role).toBe('owner');
  });

  it('accepting an invite writes the joiner membership, and the app can read it back', async () => {
    const inviter = await makeUser('root-inviter@example.com', 'Root Inviter');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Invite Co',
      ownerUserId: inviter.id,
    });
    const joiner = await makeUser('root-joiner@example.com', 'Root Joiner');

    await workspaceInvitesService.sendInvite({
      inviterUserId: inviter.id,
      inviterName: 'Root Inviter',
      workspaceId: workspace.id,
      targetEmail: joiner.email,
    });
    // The one owner-client read in this file: the invite token lives in
    // `verification`, which no service exposes.
    const row = await adminDb.verification.findFirstOrThrow({
      where: {
        identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
        value: { contains: joiner.email },
      },
    });
    const token = row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);

    await workspaceInvitesService.acceptInvite(token, { id: joiner.id, email: joiner.email });

    const members = await workspacesService.listMembers(workspace.id, inviter.id);
    expect(members.map((m) => m.userId).sort()).toEqual([inviter.id, joiner.id].sort());
    expect(members.find((m) => m.userId === joiner.id)!.role).toBe('member');
  });

  it('createOrganization writes the org AND its owner membership, both readable by the app', async () => {
    const owner = await makeUser('root-org@example.com', 'Root Org Owner');
    // The first org comes free with the first workspace; this exercises the
    // explicit multi-org path, which is the one `createOrganization` owns.
    await workspacesService.createWorkspace({ name: 'First Co', ownerUserId: owner.id });

    const created = await organizationsService.createOrganization({
      name: 'Second Co',
      actorUserId: owner.id,
    });

    // Bound read #1: the org is visible to its creator through
    // `organization_membership_visible` (which resolves via the membership row
    // the same transaction wrote — so this fails if EITHER write was refused).
    const orgs = await organizationsService.listUserOrganizations(owner.id);
    expect(orgs.map((o) => o.id)).toContain(created.id);

    // Bound read #2: the creator is the org's OWNER, read through the org-tier
    // context rather than off the DTO the write returned.
    const page = await organizationsService.listMembers({
      organizationId: created.id,
      actorUserId: owner.id,
    });
    expect(page.members.find((m) => m.userId === owner.id)!.role).toBe('owner');
  });
});
