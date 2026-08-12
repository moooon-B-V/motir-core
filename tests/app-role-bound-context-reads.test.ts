import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '@/tests/fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// A tenant read reached from inside a BOUND context must run ON that context
// (MOTIR-2774).
//
// `withWorkspaceContext` / `withUserContext` / `withWorkspaceServiceContext` bind
// their GUCs with `set_config(..., true)` — TRANSACTION-local. A repository method
// that ignores the `tx` it could have taken issues its statement on the `@/lib/db`
// singleton instead, on a different connection, where the policy sees NULL. The
// read then returns ZERO ROWS AND RAISES NOTHING: an empty answer is an ordinary
// answer, so the caller reports "missing" for something that is merely unbound.
//
// That is the third occurrence of this class (MOTIR-2569, MOTIR-2685), and the
// first two were each found the same way — by running the suite under
// TEST_DB_APP_ROLE=1. These tests are the regression net.
//
// ⚠️ DELIBERATELY NOT `describe.runIf(isAppRoleTestMode())`. CI does not set the
// flag, so a gated test would never run there. Written unconditionally, each case
// passes trivially under the bypass role (the read succeeds either way) and passes
// under the app role ONLY once the `tx` is threaded — so the same test is a live
// CI path in the default mode and the discriminator in flag mode. Every one of
// them fails under the flag on the commit before this card.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workflowsService.getInitialStatusKey — reached by createWorkItem', () => {
  it('creates a work item that lands in the project’s initial status', async () => {
    const fx = await makeWorkItemFixture();

    // The unbound read made `getInitialStatusKey` return null, and createWorkItem
    // turned that into NoInitialStatusError — a 500 reading "corrupt seed" about a
    // project whose workflow is perfectly intact.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Bound read' },
      fx.ctx,
    );

    expect(item.id).toBeTruthy();

    // The status is the project's INITIAL one, not merely non-null: a fix that
    // defaulted the status instead of reading it would pass a null check.
    const initial = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, isInitial: true },
      select: { key: true },
    });
    const row = await adminDb.workItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { status: true },
    });
    expect(row.status).toBe(initial.key);
  });
});

describe('organizationMembershipRepository.findOrganizationsByUser — the org switcher', () => {
  it('lists the organizations the user belongs to', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-list@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    // Unbound, this returned [] and the switcher rendered empty.
    const orgs = await organizationsService.listUserOrganizations(user.id);
    expect(orgs.map((o) => o.id)).toEqual([seeded.organizationId]);
  });

  it('resolves an ACTIVE organization rather than reporting the user has none', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-active@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads Active',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    // Unbound, `orgs[0]` was undefined and this returned null — indistinguishable
    // from a user who belongs to nothing.
    const active = await organizationsService.resolveActiveOrganization(user.id);
    expect(active).not.toBeNull();
    expect(active?.organization.id).toBe(seeded.organizationId);
    // The ROLE comes from a second read in the same function; assert it so a fix
    // that bound only the first read is not mistaken for a complete one.
    expect(active?.role).toBe('owner');
  });

  it('honours a preferred organization the user is a member of', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-pinned@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads Pinned',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    const active = await organizationsService.resolveActiveOrganization(
      user.id,
      seeded.organizationId,
    );
    expect(active?.organization.id).toBe(seeded.organizationId);
  });
});

describe('workItemLinkRepository.findById — reached by unlinkWorkItems', () => {
  it('removes a link the caller can see', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'B' },
      fx.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // `unlinkWorkItems` opens withWorkspaceContext and then read the link off the
    // singleton, so the link it had just been handed came back null and the call
    // threw WorkItemLinkNotFoundError. Unlinking was impossible under the role.
    await expect(workItemsService.unlinkWorkItems(link.id, fx.ctx)).resolves.toBeUndefined();

    const remaining = await adminDb.workItemLink.findUnique({ where: { id: link.id } });
    expect(remaining).toBeNull();
  });
});
