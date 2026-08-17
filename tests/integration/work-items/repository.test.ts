import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PrismaClient, Prisma } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  ParentCycleError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestProject,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';

// Integration tests for workItemRepository against a REAL Postgres (Yue's
// no-mocks rule). These exercise the DB-layer triggers through the repository
// edge: the kind-parent matrix, the depth limit, cycle prevention, the
// single-round-trip recursive-CTE subtree read, and identifier lookup.
//
// The fixture (makeFixture) + work-item builder (createWorkItem) now come from
// tests/fixtures/ (Subtask 1.4.7) — the per-file copies were unified there.
// makeFixture still forces the project identifier to "PROD" by default so
// item identifiers read as PROD-1, … (the findByIdentifier test asserts that);
// createWorkItem still does the allocate-key-then-create dance through the
// repository, so the triggers fire on this path exactly as in production.
//
// The triggers truncate with the auth tables: TRUNCATE ... CASCADE on
// workspace/user carries work_item with it (it FKs both). We add an explicit
// work_item truncate first for intent + resilience if that cascade ever
// changes.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workItemRepository.create — happy paths', () => {
  it('persists a top-level epic and returns it', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Foundation' });

    expect(epic.id).toBeTruthy();
    expect(epic.kind).toBe('epic');
    expect(epic.parentId).toBeNull();
    expect(epic.key).toBe(1);
    expect(epic.identifier).toBe('PROD-1');
    expect(epic.status).toBe('open');
    expect(epic.priority).toBe('medium');
    expect(epic.explanationSource).toBe('user_authored');

    const persisted = await adminDb.workItem.findUnique({ where: { id: epic.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.workspaceId).toBe(fx.workspace.id);
  });

  it('creates a story under an epic', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });

    expect(story.parentId).toBe(epic.id);
    expect(story.kind).toBe('story');
  });
});

describe('workItemRepository.create — kind-parent trigger', () => {
  it('rejects a story parented to a subtask with IllegalParentTypeError', async () => {
    const fx = await makeFixture();
    // Shallow, acyclic fixture so neither depth nor cycle trips before kind:
    // a top-level story with a subtask child (depth 2).
    const storyTop = await createWorkItem(fx, { kind: 'story', title: 'Top story' });
    const subtask = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'Subtask',
      parentId: storyTop.id,
    });

    await expect(
      createWorkItem(fx, { kind: 'story', title: 'Illegal', parentId: subtask.id }),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
  });

  it('rejects an orphan subtask (parentId = null) with IllegalParentTypeError', async () => {
    const fx = await makeFixture();
    await expect(createWorkItem(fx, { kind: 'subtask', title: 'Orphan' })).rejects.toBeInstanceOf(
      IllegalParentTypeError,
    );
  });
});

describe('workItemRepository.create — parent-tenancy trigger (MOTIR-2895)', () => {
  // The trigger's REJECTION is proved under the non-bypass role in
  // tests/work-item-rls.test.ts (where the parent is genuinely invisible to the
  // writer). What these two cases pin is the OTHER half — the repository edge
  // TRANSLATING its two markers into a typed error the service layer already
  // knows, so `CrossProjectParentError` means the same thing whether the service
  // pre-flight caught it or the database did. A raw 23514 escaping this edge
  // would reach a route as a bare 500.
  it('rejects a parent in another PROJECT of the same workspace with CrossProjectParentError', async () => {
    const fx = await makeFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling project',
      identifier: 'SIBL',
    });
    const fxOther = {
      ...fx,
      project: otherProject,
      projectId: otherProject.id,
      projectIdentifier: otherProject.identifier,
    };
    const foreignEpic = await createWorkItem(fxOther, { kind: 'epic', title: 'Epic over there' });

    // Kind-legal (a story under an epic) and shallow, so only the tenancy check
    // can reject it — and it sorts first anyway.
    await expect(
      createWorkItem(fx, { kind: 'story', title: 'Story here', parentId: foreignEpic.id }),
    ).rejects.toBeInstanceOf(CrossProjectParentError);
  });

  it('rejects a parent in another WORKSPACE with CrossProjectParentError', async () => {
    const fx = await makeFixture();
    const otherTenant = await makeFixture({ name: 'Other Co', identifier: 'OTHR' });
    const foreignEpic = await createWorkItem(otherTenant, {
      kind: 'epic',
      title: 'Another tenant’s epic',
    });

    // The same typed error deliberately: the marker distinguishes the workspace
    // case from the project case, the class does not (see the error's docstring).
    await expect(
      createWorkItem(fx, { kind: 'story', title: 'Story here', parentId: foreignEpic.id }),
    ).rejects.toBeInstanceOf(CrossProjectParentError);
  });
});

describe('workItemRepository.create — depth-limit trigger', () => {
  it('allows a 4-deep chain and rejects a 5th level with DepthLimitExceededError', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'L1 epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'L2 story', parentId: epic.id });
    const task = await createWorkItem(fx, { kind: 'task', title: 'L3 task', parentId: story.id });
    const subtask = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'L4 subtask',
      parentId: task.id,
    });
    expect(subtask.parentId).toBe(task.id);

    // A 5th level under the depth-4 subtask. depth fires before kind, so the
    // depth error surfaces (this case is also kind-illegal).
    await expect(
      createWorkItem(fx, { kind: 'subtask', title: 'L5 too deep', parentId: subtask.id }),
    ).rejects.toBeInstanceOf(DepthLimitExceededError);
  });
});

describe('workItemRepository.update — cycle trigger', () => {
  it('rejects re-parenting an ancestor under its descendant with ParentCycleError', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'epic', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: a.id });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C', parentId: b.id });

    // Move A (root) under C (its grandchild) → cycle. The cycle trigger fires
    // before kind, so we get ParentCycleError (not "epic can't have a parent").
    await expect(
      adminDb.$transaction((tx) => workItemRepository.update(a.id, { parentId: c.id }, tx)),
    ).rejects.toBeInstanceOf(ParentCycleError);
  });

  // Subtask 1.4.7 gap-fill: the test above closes the cycle two hops up
  // (C → B → A). This one goes one level DEEPER — a four-node chain
  // A → B → C → D where the recursive cycle CTE must walk D → C → B → A
  // (three recursion hops) to discover that A is an ancestor of D. Driven via
  // the REPOSITORY (direct update), because the SERVICE path can never reach
  // this trigger: moving an ancestor under a descendant is ALWAYS kind-illegal
  // (the kind hierarchy is a strict DAG, so an ancestor's kind can never be a
  // legal child of a descendant's kind), and workItemsService.moveWorkItem's
  // assertKindParent pre-flight throws IllegalParentTypeError first. At the DB
  // level the cycle trigger (trg_work_item_cycle) fires before depth and kind
  // (triggers run in alphabetical name order), so ParentCycleError surfaces.
  it('rejects a 3-hop re-parent cycle (A→B→C→D, move A under D) with ParentCycleError', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'epic', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: a.id });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C', parentId: b.id });
    const d = await createWorkItem(fx, { kind: 'subtask', title: 'D', parentId: c.id });

    // Move A (root) under D (its great-grandchild). The CTE recurses
    // D → C → B → A and finds the cycle on the deepest hop.
    await expect(
      adminDb.$transaction((tx) => workItemRepository.update(a.id, { parentId: d.id }, tx)),
    ).rejects.toBeInstanceOf(ParentCycleError);
  });
});

describe('workItemRepository.findSubtree', () => {
  it('returns the full 4-deep tree with depth metadata in a single query', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Root epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });
    const task = await createWorkItem(fx, { kind: 'task', title: 'Task', parentId: story.id });
    await createWorkItem(fx, { kind: 'subtask', title: 'Subtask', parentId: task.id });

    // Count DB round-trips with a query-logging client: findSubtree must issue
    // exactly ONE query (the recursive CTE), not a per-level walk.
    const loggedDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: string[] = [];
    loggedDb.$on('query', (e) => queries.push(e.query));

    let rows;
    try {
      // BOUND, and deliberately NOT moved to `adminDb` (MOTIR-2952): the SUBJECT
      // here is `findSubtree` itself, so it keeps the code-under-test's
      // connection and gets a workspace binding, exactly as its real caller
      // supplies one. `loggedDb` carries `DATABASE_URL`, which is `motir_app` in
      // a Vitest worker, and an unbound `work_item` read there answers `[]`;
      // running it as the OWNER instead would make this pass by taking the code
      // under test off the restricted role. `withWorkspaceContext` cannot serve
      // (it binds on the `@/lib/db` singleton, and the query LOG is the point of
      // this client), so the same three `set_config` calls are made inline.
      rows = await loggedDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${fx.ownerId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.project_id', ${''}, true)`;
        queries.length = 0; // the binding is setup, not the read under measurement
        return workItemRepository.findSubtree(epic.id, tx as unknown as Prisma.TransactionClient);
      });
    } finally {
      await loggedDb.$disconnect();
    }

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.depth)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.kind)).toEqual(['epic', 'story', 'task', 'subtask']);
    expect(rows[0]!.identifier).toBe('PROD-1');

    // Exactly one round-trip, and it is the recursive CTE. The transaction's own
    // BEGIN / COMMIT are Prisma-emitted control statements, not reads of the
    // subtree, so they are excluded rather than counted.
    const subtreeQueries = queries.filter((q) => !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(q));
    expect(subtreeQueries).toHaveLength(1);
    expect(subtreeQueries[0]!.toLowerCase()).toContain('recursive');
  });
});

describe('workItemRepository.lockById', () => {
  it('returns the id for an existing row and null for a missing one (inside a tx)', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Lockable' });

    const [found, missing] = await adminDb.$transaction(async (tx) => [
      await workItemRepository.lockById(epic.id, tx),
      await workItemRepository.lockById('does-not-exist', tx),
    ]);

    expect(found).toEqual({ id: epic.id });
    expect(missing).toBeNull();
  });

  it('serializes concurrent read-modify-write updates (no lost update)', async () => {
    const fx = await makeFixture();
    const item = await createWorkItem(fx, { kind: 'epic', title: 'base' });

    // Two concurrent transactions each lock the row, re-read the title, append
    // 'X', and write. The FOR UPDATE lock serializes them: the second blocks
    // until the first commits, then re-reads the committed 'baseX' and writes
    // 'baseXX'. Without the lock both would read 'base' and one write would be
    // lost (final 'baseX'). The sleep widens the contention window; the
    // assertion is order-independent — either ordering yields 'baseXX'.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const bump = (hold: number) =>
      adminDb.$transaction(async (tx) => {
        await workItemRepository.lockById(item.id, tx);
        const current = await workItemRepository.findById(item.id, tx);
        await sleep(hold);
        await workItemRepository.update(item.id, { title: `${current!.title}X` }, tx);
      });

    await Promise.all([bump(150), bump(0)]);

    const final = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findById(item.id, tx),
    );
    expect(final?.title).toBe('baseXX');
  });
});

describe('workItemRepository.findByIdentifier', () => {
  it('finds a work item by its project identifier after create', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Found me' });

    const found = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(fx.project.id, 'PROD-1', tx),
    );
    expect(found?.id).toBe(epic.id);
    expect(found?.identifier).toBe('PROD-1');

    const missing = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(fx.project.id, 'PROD-999', tx),
    );
    expect(missing).toBeNull();
  });
});

describe('workItemRepository.findByIds', () => {
  it('resolves multiple ids in one round-trip (any order) and empty input to []', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'epic', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: a.id });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C', parentId: b.id });

    // Empty input short-circuits without issuing a query.
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.findByIds([], tx),
      ),
    ).toEqual([]);

    // A single IN(...) round-trip resolves every requested id; the method
    // makes no ordering promise, so we compare as sets.
    const loggedDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: string[] = [];
    loggedDb.$on('query', (e) => queries.push(e.query));

    let rows;
    try {
      // Call through the repository (which uses the `db` singleton); the
      // logged client is used only to prove the single-query shape via an
      // identical query on the same data.
      rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.findByIds([c.id, a.id, b.id], tx),
      );
      // The MIRROR query is instrumentation, not the subject — but it is still a
      // `work_item` read on `motir_app`, so it needs the same binding or it
      // answers `[]` and the round-trip claim is measured over nothing
      // (MOTIR-2952). Bound rather than moved to `adminDb`, so the statement
      // whose shape is being counted is the one production would issue.
      const loggedRows = await loggedDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${fx.ownerId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.project_id', ${''}, true)`;
        queries.length = 0; // the binding is setup, not the read under measurement
        return tx.workItem.findMany({ where: { id: { in: [c.id, a.id, b.id] } } });
      });
      expect(loggedRows).toHaveLength(3);
    } finally {
      await loggedDb.$disconnect();
    }

    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // The mirror query on the logging client was exactly one round-trip (the
    // transaction's own BEGIN / COMMIT are control statements, not reads).
    expect(queries.filter((q) => !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(q))).toHaveLength(1);
  });
});

// Subtask 1.4.7 coverage-fill: repository read methods + filters + the
// Prisma-error → typed-error translation paths the service layer relies on but
// doesn't exercise from its happy-path tests.

describe('workItemRepository.findByProjectFiltered — filters', () => {
  it('filters by status and assignee, and excludes archived rows', async () => {
    const fx = await makeFixture();
    const open = await createWorkItem(fx, { kind: 'task', title: 'open' });
    const done = await createWorkItem(fx, { kind: 'task', title: 'done' });
    const gone = await createWorkItem(fx, { kind: 'task', title: 'archived' });
    await adminDb.$transaction((tx) =>
      workItemRepository.update(done.id, { status: 'done', assigneeId: fx.owner.id }, tx),
    );
    await adminDb.$transaction((tx) => workItemRepository.archive(gone.id, tx));

    const all = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByProjectFiltered(fx.project.id, undefined, tx),
    );
    expect(all.map((r) => r.id).sort()).toEqual([open.id, done.id].sort()); // archived excluded

    const byStatus = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByProjectFiltered(
        fx.project.id,
        {
          status: 'done',
        },
        tx,
      ),
    );
    expect(byStatus.map((r) => r.id)).toEqual([done.id]);

    const byAssignee = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByProjectFiltered(
        fx.project.id,
        {
          assigneeId: fx.owner.id,
        },
        tx,
      ),
    );
    expect(byAssignee.map((r) => r.id)).toEqual([done.id]);
  });
});

describe('workItemRepository.findByProject — pagination', () => {
  it('takes a page and resumes after a cursor (skipping the cursor row)', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });

    const firstTwo = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByProject(fx.project.id, { take: 2 }, tx),
    );
    expect(firstTwo.map((r) => r.id)).toEqual([a.id, b.id]);

    const afterB = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByProject(fx.project.id, { cursor: b.id }, tx),
    );
    expect(afterB.map((r) => r.id)).toEqual([c.id]);
  });
});

describe('workItemRepository.findSiblings', () => {
  it('returns non-archived siblings under a parent (and top-level siblings), without a tx', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const s1 = await createWorkItem(fx, { kind: 'story', title: 'S1', parentId: epic.id });
    const s2 = await createWorkItem(fx, { kind: 'story', title: 'S2', parentId: epic.id });

    // Called WITHOUT a tx (the `db`-singleton read path).
    const childSiblings = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findSiblings(fx.project.id, epic.id, tx),
    );
    expect(childSiblings.map((r) => r.id)).toEqual([s1.id, s2.id]);

    // Top-level siblings: parentId null is project-scoped, so only this epic.
    const topSiblings = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findSiblings(fx.project.id, null, tx),
    );
    expect(topSiblings.map((r) => r.id)).toEqual([epic.id]);
  });
});

describe('workItemRepository.findChildren', () => {
  it('returns only the direct, non-archived children ordered by position', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const s1 = await createWorkItem(fx, { kind: 'story', title: 'S1', parentId: epic.id });
    const s2 = await createWorkItem(fx, { kind: 'story', title: 'S2', parentId: epic.id });
    // A grandchild must NOT appear (findChildren is one level only).
    await createWorkItem(fx, { kind: 'task', title: 'GC', parentId: s1.id });

    const children = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findChildren(epic.id, tx),
    );
    expect(children.map((r) => r.id)).toEqual([s1.id, s2.id]);
  });
});

describe('workItemRepository.create / update — Prisma error translation', () => {
  it('translates a duplicate (projectId, key) to WorkItemKeyConflictError (P2002)', async () => {
    const fx = await makeFixture();
    // Insert key=1 directly, then attempt a second row with the SAME key in the
    // same project (bypassing the allocator) → unique violation → typed error.
    await adminDb.$transaction((tx) =>
      workItemRepository.create(
        {
          workspaceId: fx.workspace.id,
          projectId: fx.project.id,
          kind: 'epic',
          key: 1,
          identifier: 'PROD-1',
          title: 'first',
          reporterId: fx.owner.id,
          position: 'a0',
        },
        tx,
      ),
    );
    await expect(
      adminDb.$transaction((tx) =>
        workItemRepository.create(
          {
            workspaceId: fx.workspace.id,
            projectId: fx.project.id,
            kind: 'epic',
            key: 1, // duplicate key in the same project
            identifier: 'PROD-1b',
            title: 'second',
            reporterId: fx.owner.id,
            position: 'a1',
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkItemKeyConflictError);
  });

  it('translates an update of a missing row to WorkItemNotFoundError (P2025)', async () => {
    await expect(
      adminDb.$transaction((tx) =>
        workItemRepository.update('00000000-0000-0000-0000-000000000000', { title: 'x' }, tx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('translates an archive of a missing row to WorkItemNotFoundError (P2025)', async () => {
    await expect(
      adminDb.$transaction((tx) =>
        workItemRepository.archive('00000000-0000-0000-0000-000000000000', tx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('unarchive clears archivedAt (the inverse of archive)', async () => {
    const fx = await makeFixture();
    const item = await createWorkItem(fx, { kind: 'task', title: 'restore me' });
    await adminDb.$transaction((tx) => workItemRepository.archive(item.id, tx));
    const restored = await adminDb.$transaction((tx) => workItemRepository.unarchive(item.id, tx));
    expect(restored.archivedAt).toBeNull();
  });

  it('translates an unarchive of a missing row to WorkItemNotFoundError (P2025)', async () => {
    await expect(
      adminDb.$transaction((tx) =>
        workItemRepository.unarchive('00000000-0000-0000-0000-000000000000', tx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});
