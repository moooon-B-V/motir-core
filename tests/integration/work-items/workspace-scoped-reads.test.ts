import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';

// Service-layer integration tests for the three workspace-scoped READ methods
// Subtask 1.4.8 added to workItemsService: getWorkItem / listRevisions /
// getLink. They are the explicit application-layer tenancy gate behind the
// `_test` route handlers — the work_item RLS policy (1.4.5) is the structural
// backstop, but it is INERT on the dev/CI `prodect` superuser connection
// (BYPASSRLS), so these methods enforce the workspace boundary themselves and
// throw a 404-shaped typed error (never a 403) on a cross-tenant miss.
//
// Real Postgres, no mocks (Yue's rule). Each test builds two independent
// tenants (fxA, fxB) via the shared fixtures so the cross-workspace branches
// are exercised, not just the happy path. These tests also keep
// workItemsService.ts above the ≥90% per-file coverage threshold
// (vitest.config.ts) for the new branches.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getWorkItem — workspace-scoped single fetch', () => {
  it('returns the DTO for an item in the active workspace', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Q3 launch' },
      fx.ctx,
    );
    const got = await workItemsService.getWorkItem(created.id, fx.ctx);
    expect(got.id).toBe(created.id);
    expect(got.title).toBe('Q3 launch');
  });

  it('throws WorkItemNotFoundError for an unknown id', async () => {
    const fx = await makeFixture();
    await expect(workItemsService.getWorkItem('does-not-exist', fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });

  it("throws WorkItemNotFoundError for another workspace's item (no existence leak)", async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const bItem = await workItemsService.createWorkItem(
      { projectId: fxB.projectId, kind: 'epic', title: "B's secret" },
      fxB.ctx,
    );
    // A asks for B's item by exact id → indistinguishable from never-existed.
    await expect(workItemsService.getWorkItem(bItem.id, fxA.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('listRevisions — workspace-scoped revision feed', () => {
  it('returns the revision rows (newest first) for an item in the active workspace', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Q3 launch' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(created.id, { title: 'Q3 launch (revised)' }, fx.ctx);

    const revisions = await workItemsService.listRevisions(created.id, fx.ctx);
    expect(revisions.length).toBe(2);
    // Newest-first: the update precedes the create in the feed.
    expect(revisions[0]!.changeKind).toBe('updated');
    expect(revisions[1]!.changeKind).toBe('created');
    expect(revisions[0]!.diff).toMatchObject({
      title: { from: 'Q3 launch', to: 'Q3 launch (revised)' },
    });
  });

  it("throws WorkItemNotFoundError for another workspace's item", async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const bItem = await workItemsService.createWorkItem(
      { projectId: fxB.projectId, kind: 'epic', title: "B's item" },
      fxB.ctx,
    );
    await expect(workItemsService.listRevisions(bItem.id, fxA.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('getLink — workspace-scoped single link fetch', () => {
  it('returns the DTO for a link in the active workspace', async () => {
    const fx = await makeFixture();
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const y = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Y' },
      fx.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const got = await workItemsService.getLink(link.id, fx.ctx);
    expect(got.id).toBe(link.id);
    expect(got.fromId).toBe(x.id);
    expect(got.toId).toBe(y.id);
    expect(got.kind).toBe('is_blocked_by');
  });

  it('throws WorkItemLinkNotFoundError for an unknown id', async () => {
    const fx = await makeFixture();
    await expect(workItemsService.getLink('does-not-exist', fx.ctx)).rejects.toBeInstanceOf(
      WorkItemLinkNotFoundError,
    );
  });

  it("throws WorkItemLinkNotFoundError for another workspace's link", async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const x = await workItemsService.createWorkItem(
      { projectId: fxB.projectId, kind: 'task', title: 'BX' },
      fxB.ctx,
    );
    const y = await workItemsService.createWorkItem(
      { projectId: fxB.projectId, kind: 'task', title: 'BY' },
      fxB.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
      fxB.ctx,
    );
    await expect(workItemsService.getLink(link.id, fxA.ctx)).rejects.toBeInstanceOf(
      WorkItemLinkNotFoundError,
    );
  });
});
