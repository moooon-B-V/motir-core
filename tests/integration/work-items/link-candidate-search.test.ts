import type { WorkItem, WorkItemKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService, QUICK_SEARCH_DEFAULT_LIMIT } from '@/lib/services/workItemsService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { usersService } from '@/lib/services/usersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 6.9.2 — the link/blocker picker retrofit (closes finding #98).
//
// `listLinkCandidates` / `listCreateLinkCandidates` no longer load a fixed
// newest-50 window and filter client-side; they COMPOSE the 6.9.1 server-side
// quick-search (key + title trgm, workspace + Story-6.4-permission scoped,
// bounded) with the direction-aware exclusions. Real Postgres, no mocks. This
// file pins what 6.9.2's AC names for the searched candidate read: the #98
// regression (an early item IS reachable from a late item's picker — the exact
// case the cap broke), the exclusions preserved UNDER search, the inherited
// permission scope, the bound, and the empty/short-query guard. (The large-seed
// E2E + a11y sweep are 6.9.3.)

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Fast non-archived item insert through the repo (the quick-search.test path). */
async function seedItem(args: {
  workspaceId: string;
  projectId: string;
  identifier: string;
  reporterId: string;
  title: string;
  kind?: WorkItemKind;
}): Promise<WorkItem> {
  return db.$transaction(async (tx) => {
    const key = await projectRepository.allocateWorkItemNumber(args.projectId, tx);
    return workItemRepository.create(
      {
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        parentId: null,
        kind: args.kind ?? 'task',
        key,
        identifier: `${args.identifier}-${key}`,
        title: args.title,
        reporterId: args.reporterId,
        position: String(key).padStart(6, '0'),
      },
      tx,
    );
  });
}

describe('listLinkCandidates — searched candidate read (6.9.2; closes #98)', () => {
  it('finds an EARLY-created item from a LATE item — outside any newest-50 window', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const base = { workspaceId: fx.workspaceId, projectId: fx.projectId, reporterId: fx.ownerId };

    // The earliest item — the one the old newest-50 cap buried.
    const early = await seedItem({ ...base, identifier: 'PROD', title: 'needle in the haystack' });
    // 60 newer items push `early` far outside the newest-50 window.
    for (let i = 0; i < 60; i++) {
      await seedItem({ ...base, identifier: 'PROD', title: `filler row ${i}` });
    }
    // The picker is opened on the NEWEST item.
    const subject = await seedItem({ ...base, identifier: 'PROD', title: 'the subject' });

    // Searching the early item's title surfaces it — by key works too.
    const byTitle = await workItemsService.listLinkCandidates(
      subject.id,
      'blocked_by',
      'needle',
      fx.ctx,
    );
    expect(byTitle.map((c) => c.id)).toContain(early.id);

    const byKey = await workItemsService.listLinkCandidates(
      subject.id,
      'blocked_by',
      early.identifier,
      fx.ctx,
    );
    expect(byKey.map((c) => c.id)).toContain(early.id);
  });

  it('preserves the exclusion set UNDER search — self + already-linked never appear even when they match', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const make = (title: string) =>
      workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
    // All four share the "node" token so one query matches every one.
    const subject = await make('subject node');
    const blocker = await make('alpha node');
    const free = await make('beta node');

    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const blockedByIds = (
      await workItemsService.listLinkCandidates(subject.id, 'blocked_by', 'node', fx.ctx)
    ).map((c) => c.id);
    // Self is excluded even though "subject node" matches the query…
    expect(blockedByIds).not.toContain(subject.id);
    // …and the already-blocked-by target is excluded for THAT relationship…
    expect(blockedByIds).not.toContain(blocker.id);
    // …while the unlinked match is offered.
    expect(blockedByIds).toContain(free.id);

    // Direction-aware: the same blocker is available under a DIFFERENT
    // relationship (you can also relate to it).
    const relatesIds = (
      await workItemsService.listLinkCandidates(subject.id, 'relates_to', 'node', fx.ctx)
    ).map((c) => c.id);
    expect(relatesIds).toContain(blocker.id);
  });

  it('returns [] for an empty / below-minimum query (no unbounded browse)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const subject = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'subject' },
      fx.ctx,
    );
    await seedItem({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      reporterId: fx.ownerId,
      identifier: 'PROD',
      title: 'a candidate',
    });

    expect(await workItemsService.listLinkCandidates(subject.id, 'blocked_by', '', fx.ctx)).toEqual(
      [],
    );
    expect(
      await workItemsService.listLinkCandidates(subject.id, 'blocked_by', '   ', fx.ctx),
    ).toEqual([]);
    // One char is below QUICK_SEARCH_MIN_QUERY_LENGTH.
    expect(
      await workItemsService.listLinkCandidates(subject.id, 'blocked_by', 'a', fx.ctx),
    ).toEqual([]);
  });

  it('is bounded — a broad query never returns more than the default page', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const base = { workspaceId: fx.workspaceId, projectId: fx.projectId, reporterId: fx.ownerId };
    const subject = await seedItem({ ...base, identifier: 'PROD', title: 'subject' });
    for (let i = 0; i < QUICK_SEARCH_DEFAULT_LIMIT + 10; i++) {
      await seedItem({ ...base, identifier: 'PROD', title: `widget number ${i}` });
    }
    const results = await workItemsService.listLinkCandidates(
      subject.id,
      'relates_to',
      'widget',
      fx.ctx,
    );
    expect(results.length).toBeLessThanOrEqual(QUICK_SEARCH_DEFAULT_LIMIT);
  });
});

describe('link candidate search — permission scope inherited (Story 6.4)', () => {
  it('an outsider cannot find a private-project item via either link picker; the owner can', async () => {
    const owner = await usersService.createUser({
      email: 'owner-lc@ex.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'LC WS',
      ownerUserId: owner.id,
    });
    const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

    const pub = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Public',
      identifier: 'PUB',
    });
    const priv = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Private',
      identifier: 'PRIV',
    });
    await projectMembersService.setAccessLevel({
      key: priv.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    const outsider = await usersService.createUser({
      email: 'outsider-lc@ex.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });
    const outsiderCtx: ServiceContext = { userId: outsider.id, workspaceId: workspace.id };

    // The picker is opened on a PUBLIC-project item (the outsider can see it).
    const subject = await seedItem({
      workspaceId: workspace.id,
      projectId: pub.id,
      identifier: 'PUB',
      reporterId: owner.id,
      title: 'public subject widget',
    });
    const privItem = await seedItem({
      workspaceId: workspace.id,
      projectId: priv.id,
      identifier: 'PRIV',
      reporterId: owner.id,
      title: 'secret widget',
    });

    // Detail-page picker.
    const asOutsider = await workItemsService.listLinkCandidates(
      subject.id,
      'relates_to',
      'widget',
      outsiderCtx,
    );
    expect(asOutsider.map((c) => c.id)).not.toContain(privItem.id);

    const asOwner = await workItemsService.listLinkCandidates(
      subject.id,
      'relates_to',
      'widget',
      ownerCtx,
    );
    expect(asOwner.map((c) => c.id)).toContain(privItem.id);

    // Create-modal picker rides the same permission-scoped search.
    const createAsOutsider = await workItemsService.listCreateLinkCandidates('widget', outsiderCtx);
    expect(createAsOutsider.map((c) => c.id)).not.toContain(privItem.id);
    const createAsOwner = await workItemsService.listCreateLinkCandidates('widget', ownerCtx);
    expect(createAsOwner.map((c) => c.id)).toContain(privItem.id);
  });
});
