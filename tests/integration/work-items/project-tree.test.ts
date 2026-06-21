import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// Integration tests for the project issue-tree read (Subtask 2.5.1):
// workItemRepository.findProjectForest (the single recursive-CTE round-trip +
// explicit workspace gate) and workItemsService.getProjectTree (the nesting +
// context-preserving filter that backs the /items list view). Real Postgres,
// no mocks (Yue's rule). Each test builds its own tree; cross-workspace cases
// build two independent tenants so the tenant gate is exercised, not assumed.

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

/** Direct column pokes (tests may reach the db to set state — CLAUDE.md). */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}
async function setAssignee(id: string, assigneeId: string | null): Promise<void> {
  await db.workItem.update({ where: { id }, data: { assigneeId } });
}
async function setType(id: string, type: Prisma.WorkItemUpdateInput['type']): Promise<void> {
  await db.workItem.update({ where: { id }, data: { type } });
}

/**
 * Build the canonical test forest in one fixture's project:
 *
 *   E  (epic, root)
 *   ├─ A  (story)
 *   │  └─ A1 (task)
 *   │     └─ A1a (subtask)        ← depth 4
 *   └─ B  (story)
 *      └─ B1 (task)
 *   X  (bug, root)
 *
 * Keys are allocated in creation order (E=1, A=2, A1=3, A1a=4, B=5, B1=6, X=7),
 * which equals the key-asc order the tree must come back in.
 */
async function buildForest(fx: WorkItemFixture) {
  const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
  const A = await createWorkItem(fx, { kind: 'story', title: 'Story A', parentId: E.id });
  const A1 = await createWorkItem(fx, { kind: 'task', title: 'Task A1', parentId: A.id });
  const A1a = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A1a', parentId: A1.id });
  const B = await createWorkItem(fx, { kind: 'story', title: 'Story B', parentId: E.id });
  const B1 = await createWorkItem(fx, { kind: 'task', title: 'Task B1', parentId: B.id });
  const X = await createWorkItem(fx, { kind: 'bug', title: 'Bug X' });
  return { E, A, A1, A1a, B, B1, X };
}

/** True when this node and every descendant are `matched`. */
function allMatched(node: WorkItemTreeNodeDto): boolean {
  return node.matched && node.children.every(allMatched);
}

/** Find a node anywhere in the forest by identifier (depth-first). */
function findNode(
  nodes: WorkItemTreeNodeDto[],
  identifier: string,
): WorkItemTreeNodeDto | undefined {
  for (const n of nodes) {
    if (n.identifier === identifier) return n;
    const hit = findNode(n.children, identifier);
    if (hit) return hit;
  }
  return undefined;
}

describe('workItemsService.getProjectTree — nesting (no filter)', () => {
  it('nests non-archived issues by parent, key-asc, with row fields + depth + hasChildren', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);

    // Two roots, key-asc: Epic E (PROD-1) then Bug X (PROD-7).
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-7']);

    const e = tree[0]!;
    expect(e.kind).toBe('epic');
    expect(e.title).toBe('Epic E');
    expect(e.depth).toBe(1);
    expect(e.hasChildren).toBe(true);
    expect(e.matched).toBe(true);
    // children key-asc: Story A (PROD-2) then Story B (PROD-5).
    expect(e.children.map((c) => c.identifier)).toEqual(['PROD-2', 'PROD-5']);

    // Depth ≥3 chain E → A → A1 → A1a, depths 1..4.
    const a = e.children[0]!;
    const a1 = a.children[0]!;
    const a1a = a1.children[0]!;
    expect([a.depth, a1.depth, a1a.depth]).toEqual([2, 3, 4]);
    expect(a1a.identifier).toBe('PROD-4');
    expect(a1a.kind).toBe('subtask');
    expect(a1a.hasChildren).toBe(false);
    expect(a1a.children).toEqual([]);

    // The bug root is a leaf here.
    const x = tree[1]!;
    expect(x.kind).toBe('bug');
    expect(x.hasChildren).toBe(false);

    // The row carries assignee (null here) and status (column default).
    expect(e.assigneeId).toBeNull();
    expect(typeof e.status).toBe('string');
    void t;
  });

  it("projects each leaf's work `type` through the forest CTE (Subtask 8.8.9)", async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    // A leaf carries a work type; the container epic carries none.
    await setType(t.A1a.id, 'design');
    await setType(t.X.id, 'code');

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);

    expect(findNode(tree, 'PROD-4')!.type).toBe('design'); // subtask A1a
    expect(findNode(tree, 'PROD-7')!.type).toBe('code'); // bug X
    expect(findNode(tree, 'PROD-1')!.type).toBeNull(); // epic E — no work type
  });

  it('excludes archived items (and their descendants drop out of the forest)', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await db.workItem.update({ where: { id: t.B.id }, data: { archivedAt: new Date() } });

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    // Story B is archived; B1 was reachable only through B → both gone.
    expect(findNode(tree, 'PROD-5')).toBeUndefined();
    expect(findNode(tree, 'PROD-6')).toBeUndefined();
    // The A-branch and the bug root remain.
    expect(findNode(tree, 'PROD-4')).toBeDefined();
    expect(findNode(tree, 'PROD-7')).toBeDefined();
    // Epic E now has a single child (Story A).
    expect(tree[0]!.children.map((c) => c.identifier)).toEqual(['PROD-2']);
  });

  it('returns [] for an empty project', async () => {
    const fx = await makeFixture();
    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    expect(tree).toEqual([]);
  });
});

describe('workItemsService.getProjectTree — tenant gate (finding #26)', () => {
  it('throws ProjectNotFoundError for an unknown projectId', async () => {
    const fx = await makeFixture();
    await expect(
      workItemsService.getProjectTree('does-not-exist', {}, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("throws ProjectNotFoundError for another workspace's project (no existence leak)", async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    await buildForest(fxB);
    // A asks for B's project by exact id → indistinguishable from never-existed.
    await expect(
      workItemsService.getProjectTree(fxB.projectId, {}, fxA.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('workItemsService.getProjectTree — context-preserving filter', () => {
  it('retains the ancestor chain of a deep text match (ancestors muted, match matched)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);

    const tree = await workItemsService.getProjectTree(fx.projectId, { text: 'A1a' }, fx.ctx);

    // Only the E → A → A1 → A1a chain survives; B-branch and X are pruned.
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1']);
    const a1a = findNode(tree, 'PROD-4')!;
    expect(a1a.matched).toBe(true);
    // The ancestors are retained but NOT matched (rendered muted by the UI).
    for (const id of ['PROD-1', 'PROD-2', 'PROD-3']) {
      expect(findNode(tree, id)!.matched).toBe(false);
    }
    // hasChildren stays consistent with the pruned set: A1 keeps its one match.
    expect(findNode(tree, 'PROD-3')!.hasChildren).toBe(true);
    expect(findNode(tree, 'PROD-5')).toBeUndefined();
    expect(findNode(tree, 'PROD-7')).toBeUndefined();
  });

  it('filters by kind, keeping matches + ancestors', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    const tree = await workItemsService.getProjectTree(fx.projectId, { kinds: ['bug'] }, fx.ctx);
    // Only Bug X (PROD-7) is a bug, and it is a root → just it.
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-7']);
    expect(tree[0]!.matched).toBe(true);
  });

  it('filters by work type (set) + the Untyped null bucket (6.15.5 facet)', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setType(t.A1.id, 'code'); // Task A1 → code
    await setType(t.B1.id, 'design'); // Task B1 → design
    // every other node keeps its default null `type` (epics/stories are untyped).

    // types = [code] → A1 matched, ancestors A + E retained; the B + X branches drop.
    const code = await workItemsService.getProjectTree(fx.projectId, { types: ['code'] }, fx.ctx);
    expect(findNode(code, 'PROD-3')!.matched).toBe(true); // A1
    expect(findNode(code, 'PROD-2')!.matched).toBe(false); // A (retained ancestor)
    expect(findNode(code, 'PROD-1')!.matched).toBe(false); // E (retained ancestor)
    expect(findNode(code, 'PROD-6')).toBeUndefined(); // B1 (design) dropped
    expect(findNode(code, 'PROD-7')).toBeUndefined(); // X (untyped) dropped

    // includeUntyped → every null-type node matches; the two typed tasks do not.
    const untyped = await workItemsService.getProjectTree(
      fx.projectId,
      { includeUntyped: true },
      fx.ctx,
    );
    expect(findNode(untyped, 'PROD-7')!.matched).toBe(true); // X (untyped)
    expect(findNode(untyped, 'PROD-4')!.matched).toBe(true); // A1a (untyped)
    expect(findNode(untyped, 'PROD-3')!.matched).toBe(false); // A1 (code) — retained ancestor of A1a
    expect(findNode(untyped, 'PROD-6')).toBeUndefined(); // B1 (design) leaf → pruned

    // types = [design] OR Untyped → B1 + every untyped node; A1 (code) excluded.
    const designOrUntyped = await workItemsService.getProjectTree(
      fx.projectId,
      { types: ['design'], includeUntyped: true },
      fx.ctx,
    );
    expect(findNode(designOrUntyped, 'PROD-6')!.matched).toBe(true); // B1 (design)
    expect(findNode(designOrUntyped, 'PROD-7')!.matched).toBe(true); // X (untyped)
    // A1 (code) doesn't match, but is retained as the ancestor of A1a (untyped).
    expect(findNode(designOrUntyped, 'PROD-3')!.matched).toBe(false);
    expect(findNode(designOrUntyped, 'PROD-4')!.matched).toBe(true); // A1a (untyped)
  });

  it('filters by status, retaining the ancestor chain', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setStatus(t.A1a.id, 'done');

    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { statuses: ['done'] },
      fx.ctx,
    );
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1']);
    expect(findNode(tree, 'PROD-4')!.matched).toBe(true);
    expect(findNode(tree, 'PROD-1')!.matched).toBe(false);
  });

  it('filters by assignee (set), and includeUnassigned selects UNASSIGNED', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setAssignee(t.B1.id, fx.ownerId); // only B1 is assigned

    // assignee = owner → the E → B → B1 chain only.
    const assigned = await workItemsService.getProjectTree(
      fx.projectId,
      { assigneeIds: [fx.ownerId] },
      fx.ctx,
    );
    expect(findNode(assigned, 'PROD-6')!.matched).toBe(true);
    expect(findNode(assigned, 'PROD-1')!.matched).toBe(false); // retained ancestor
    expect(findNode(assigned, 'PROD-5')!.matched).toBe(false); // retained ancestor
    expect(findNode(assigned, 'PROD-2')).toBeUndefined(); // A-branch dropped

    // assignee = null (Unassigned) → every node EXCEPT the assigned B1. Story B
    // is itself unassigned, so it matches in its own right (and loses its only
    // child, B1, which IS assigned → pruned).
    const unassigned = await workItemsService.getProjectTree(
      fx.projectId,
      { includeUnassigned: true },
      fx.ctx,
    );
    expect(findNode(unassigned, 'PROD-4')!.matched).toBe(true);
    expect(findNode(unassigned, 'PROD-7')!.matched).toBe(true);
    expect(findNode(unassigned, 'PROD-6')).toBeUndefined(); // B1 is assigned → excluded
    const b = findNode(unassigned, 'PROD-5')!;
    expect(b.matched).toBe(true); // B itself is unassigned → a match
    expect(b.hasChildren).toBe(false); // its only child B1 was pruned out
  });

  it('treats a blank text filter as no filter (every node matched)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    const tree = await workItemsService.getProjectTree(fx.projectId, { text: '   ' }, fx.ctx);
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-7']);
    expect(tree.every((n) => n.matched)).toBe(true);
  });

  it('escapes LIKE metacharacters so the text filter matches them literally', async () => {
    const fx = await makeFixture();
    const literal = await createWorkItem(fx, { kind: 'bug', title: 'Flaky at 50% load' });
    await createWorkItem(fx, { kind: 'bug', title: 'Throughput 5099 rps' });

    // "50%" must match the literal "50%", NOT "50<anything>" (so 5099 is excluded).
    const tree = await workItemsService.getProjectTree(fx.projectId, { text: '50%' }, fx.ctx);
    const matched = tree.filter((n) => n.matched).map((n) => n.id);
    expect(matched).toEqual([literal.id]);
  });

  // --- multi-select facets (Subtask 2.5.4: OR within a facet, AND across) -----

  it('kinds is OR within the facet — any of the listed kinds matches', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    // story OR bug → A (PROD-2), B (PROD-5), and Bug X (PROD-7). The stories'
    // task/subtask descendants don't match and prune away; E is the retained
    // ancestor of the two stories.
    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { kinds: ['story', 'bug'] },
      fx.ctx,
    );
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-7']);
    expect(findNode(tree, 'PROD-2')!.matched).toBe(true);
    expect(findNode(tree, 'PROD-5')!.matched).toBe(true);
    expect(findNode(tree, 'PROD-7')!.matched).toBe(true);
    expect(findNode(tree, 'PROD-1')!.matched).toBe(false); // retained ancestor
    expect(findNode(tree, 'PROD-3')).toBeUndefined(); // task A1 pruned
    expect(findNode(tree, 'PROD-6')).toBeUndefined(); // task B1 pruned
  });

  it('statuses is OR within the facet — any of the listed status keys matches', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setStatus(t.A1a.id, 'done');
    await setStatus(t.B1.id, 'in_progress');

    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { statuses: ['done', 'in_progress'] },
      fx.ctx,
    );
    expect(findNode(tree, 'PROD-4')!.matched).toBe(true); // A1a done
    expect(findNode(tree, 'PROD-6')!.matched).toBe(true); // B1 in_progress
    expect(findNode(tree, 'PROD-1')!.matched).toBe(false); // retained ancestor
    expect(findNode(tree, 'PROD-7')).toBeUndefined(); // Bug X (todo) excluded
  });

  it('the assignee facet OR-s explicit member ids with the Unassigned bucket', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setAssignee(t.B1.id, fx.ownerId); // B1 assigned; everything else unassigned

    // assigneeIds:[owner] OR includeUnassigned → the union is the WHOLE forest:
    // B1 matches via the id arm, every other node via the Unassigned arm.
    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { assigneeIds: [fx.ownerId], includeUnassigned: true },
      fx.ctx,
    );
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-7']);
    expect(findNode(tree, 'PROD-6')!.matched).toBe(true); // assigned arm
    expect(findNode(tree, 'PROD-3')!.matched).toBe(true); // unassigned arm
    expect(tree.every((n) => allMatched(n))).toBe(true);
  });

  it('ANDs across facets — kind AND unassigned narrows to unassigned items of that kind', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setAssignee(t.B1.id, fx.ownerId); // the only assigned task

    // kinds:[task] AND includeUnassigned → tasks with no assignee. A1 (PROD-3)
    // is an unassigned task → matches; B1 (PROD-6) is a task but assigned → out.
    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { kinds: ['task'], includeUnassigned: true },
      fx.ctx,
    );
    expect(findNode(tree, 'PROD-3')!.matched).toBe(true);
    expect(findNode(tree, 'PROD-6')).toBeUndefined(); // assigned task excluded
    expect(findNode(tree, 'PROD-1')!.matched).toBe(false); // retained ancestor
  });

  it('empty facet arrays are treated as no filter (the full forest)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    const tree = await workItemsService.getProjectTree(
      fx.projectId,
      { kinds: [], statuses: [], assigneeIds: [] },
      fx.ctx,
    );
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-7']);
    expect(tree.every((n) => allMatched(n))).toBe(true);
  });
});

describe('workItemRepository.findProjectForest — single round-trip + workspace gate', () => {
  it('issues exactly ONE recursive-CTE query for the whole forest (no N+1)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);

    const loggedDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: string[] = [];
    loggedDb.$on('query', (e) => queries.push(e.query));

    let rows;
    try {
      rows = await workItemRepository.findProjectForest(
        fx.projectId,
        fx.workspaceId,
        {},
        loggedDb as unknown as Prisma.TransactionClient,
      );
    } finally {
      await loggedDb.$disconnect();
    }

    expect(rows).toHaveLength(7);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.toLowerCase()).toContain('recursive');
    // Every row matched (no filter) and depth is populated.
    expect(rows.every((r) => r.matched)).toBe(true);
    expect(rows.find((r) => r.identifier === 'PROD-4')!.depth).toBe(4);
  });

  it('returns [] when the workspaceId does not match the project (cross-tenant gate)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    await buildForest(fxA);

    // Right project, WRONG workspace → the anchor's workspace filter yields nothing,
    // so no row (root or descendant) can leak across the tenant boundary.
    const rows = await workItemRepository.findProjectForest(fxA.projectId, fxB.workspaceId, {});
    expect(rows).toEqual([]);
  });
});
