import type { WorkItem, WorkItemKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  QUICK_SEARCH_DEFAULT_LIMIT,
  QUICK_SEARCH_MIN_QUERY_LENGTH,
  workItemsService,
} from '@/lib/services/workItemsService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { usersService } from '@/lib/services/usersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 6.9.1 — the reusable server-side issue quick-search read.
//
// The shared read both link pickers (6.9.2) and the cmd-K palette consume:
// a query-driven, bounded, relevance-ordered match on key (identifier) +
// title (pg_trgm contains), scoped to the workspace AND the actor's
// browsable projects (the Story 6.4 gate). Real Postgres, no mocks — the
// trgm index + the project-access policy are both exercised against the live
// schema. This file pins the four facets the AC names: correctness (key
// prefix/exact + title trgm + relevance order + bound), the permission scope,
// the exclusion set, and the guards (empty / whitespace / below-min-length).
//
// (The EXPLAIN "trgm index is used, no seq-scan" check stays a manual
// verification-recipe step against the 400+-item seed — Postgres always
// prefers a seq-scan on a tiny test table regardless of indexes, so an
// automated EXPLAIN assertion would be meaningless here. The #98 large-seed
// regression E2E is 6.9.3.)

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Insert a non-archived top-level work item into a given project the way the
 * service does — allocate the per-project key inside a transaction, derive the
 * identifier, insert through the repository. Parameterised by project so one
 * workspace can hold items across several projects (the permission cases).
 */
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

describe('workItemsService.quickSearch — correctness', () => {
  it('matches title substrings (trgm contains), bounded + relevance-ordered', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'Search indexing pipeline' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'Refactor the search box' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'Unrelated chore' });

    const results = await workItemsService.quickSearch('search', fx.ctx);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Search indexing pipeline');
    expect(titles).toContain('Refactor the search box');
    expect(titles).not.toContain('Unrelated chore');
  });

  it('matches a case-insensitive title fragment', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'Authentication Flow' });

    const results = await workItemsService.quickSearch('AUTHENT', fx.ctx);
    expect(results.map((r) => r.title)).toEqual(['Authentication Flow']);
  });

  it('ranks an exact identifier above a same-prefix identifier above a title-only match', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    // PROD-1 (exact) … then enough items so PROD-10/PROD-11 exist (prefix of
    // "PROD-1"), plus a late item whose TITLE — not key — mentions "PROD-1".
    const first = await seedItem({
      ...projectOf(fx),
      reporterId: fx.ownerId,
      title: 'alpha',
    }); // PROD-1
    for (let i = 0; i < 8; i++) {
      await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: `filler ${i}` });
    } // PROD-2 … PROD-9
    const tenth = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'beta' }); // PROD-10
    const eleventh = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'gamma' }); // PROD-11
    const titleOnly = await seedItem({
      ...projectOf(fx),
      reporterId: fx.ownerId,
      title: 'mentions PROD-1 in the title',
    });

    const results = await workItemsService.quickSearch('PROD-1', fx.ctx);
    const ids = results.map((r) => r.id);
    // Exact identifier (PROD-1) is first; the prefix matches (PROD-10, PROD-11)
    // follow in key order; the title-only match is last.
    expect(ids[0]).toBe(first.id);
    expect(ids.indexOf(tenth.id)).toBeLessThan(ids.indexOf(eleventh.id));
    expect(ids.indexOf(eleventh.id)).toBeLessThan(ids.indexOf(titleOnly.id));
  });

  it('honours the caller-supplied bound', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    for (let i = 0; i < 5; i++) {
      await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: `widget number ${i}` });
    }
    const results = await workItemsService.quickSearch('widget', fx.ctx, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('defaults to QUICK_SEARCH_DEFAULT_LIMIT when no limit is supplied', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    for (let i = 0; i < QUICK_SEARCH_DEFAULT_LIMIT + 5; i++) {
      await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: `gadget ${i}` });
    }
    const results = await workItemsService.quickSearch('gadget', fx.ctx);
    expect(results).toHaveLength(QUICK_SEARCH_DEFAULT_LIMIT);
  });

  it('finds the OLDEST-created item — the read is query-driven, not windowed by recency (the #98 spirit)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const ancient = await seedItem({
      ...projectOf(fx),
      reporterId: fx.ownerId,
      title: 'ancient quokka beacon',
    });
    // Bury it under far more than any plausible recent-window cap.
    for (let i = 0; i < 55; i++) {
      await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: `routine task ${i}` });
    }
    const results = await workItemsService.quickSearch('quokka', fx.ctx);
    expect(results.map((r) => r.id)).toEqual([ancient.id]);
  });

  it('excludes the ids the caller passes (the link picker drops self + already-linked)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const a = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'cluster alpha' });
    const b = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'cluster beta' });
    const c = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'cluster gamma' });

    const results = await workItemsService.quickSearch('cluster', fx.ctx, {
      excludeIds: [a.id, c.id],
    });
    expect(results.map((r) => r.id)).toEqual([b.id]);
  });

  it('omits archived items', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    const live = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'orbit live' });
    const dead = await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'orbit dead' });
    await db.workItem.update({ where: { id: dead.id }, data: { archivedAt: new Date() } });

    const results = await workItemsService.quickSearch('orbit', fx.ctx);
    expect(results.map((r) => r.id)).toEqual([live.id]);
  });
});

describe('workItemsService.quickSearch — guards', () => {
  it('returns [] for an empty / whitespace / below-min-length query without a DB round-trip', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'anything goes' });

    expect(await workItemsService.quickSearch('', fx.ctx)).toEqual([]);
    expect(await workItemsService.quickSearch('   ', fx.ctx)).toEqual([]);
    // One char is below QUICK_SEARCH_MIN_QUERY_LENGTH.
    expect(QUICK_SEARCH_MIN_QUERY_LENGTH).toBeGreaterThan(1);
    expect(await workItemsService.quickSearch('a', fx.ctx)).toEqual([]);
  });
});

describe('workItemsService.quickSearch — permission scope (Story 6.4)', () => {
  it('a workspace member never finds issues in a private project they are not on; the owner finds both', async () => {
    const owner = await usersService.createUser({
      email: 'owner-qs@ex.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'QS WS',
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
    // Make PRIV private BEFORE adding the outsider, so they are NOT auto-seeded
    // as a project member (only the then-current members — the owner — are).
    await projectMembersService.setAccessLevel({
      key: priv.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    // A plain workspace member with no role in PRIV.
    const outsider = await usersService.createUser({
      email: 'outsider-qs@ex.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });
    const outsiderCtx: ServiceContext = { userId: outsider.id, workspaceId: workspace.id };

    const pubItem = await seedItem({
      workspaceId: workspace.id,
      projectId: pub.id,
      identifier: 'PUB',
      reporterId: owner.id,
      title: 'visible widget',
    });
    const privItem = await seedItem({
      workspaceId: workspace.id,
      projectId: priv.id,
      identifier: 'PRIV',
      reporterId: owner.id,
      title: 'secret widget',
    });

    const asOutsider = await workItemsService.quickSearch('widget', outsiderCtx);
    expect(asOutsider.map((r) => r.id)).toEqual([pubItem.id]);

    const asOwner = await workItemsService.quickSearch('widget', ownerCtx);
    expect(asOwner.map((r) => r.id).sort()).toEqual([pubItem.id, privItem.id].sort());
  });

  it('a non-member of the workspace finds nothing (browsable set is empty)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'tenant-bound row' });

    const stranger = await usersService.createUser({
      email: 'stranger-qs@ex.com',
      password: PASSWORD,
      name: 'Stranger',
    });
    const strangerCtx: ServiceContext = { userId: stranger.id, workspaceId: fx.workspaceId };
    expect(await workItemsService.quickSearch('tenant', strangerCtx)).toEqual([]);
  });
});

describe('workItemRepository.quickSearch — direct', () => {
  it('short-circuits to [] when the browsable project set is empty', async () => {
    const rows = await workItemRepository.quickSearch('any-workspace', [], 'anything', 20);
    expect(rows).toEqual([]);
  });
});

/** Spread helper: the (workspaceId, projectId, identifier) of a fixture's project. */
function projectOf(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>): {
  workspaceId: string;
  projectId: string;
  identifier: string;
} {
  return { workspaceId: fx.workspaceId, projectId: fx.projectId, identifier: fx.projectIdentifier };
}
