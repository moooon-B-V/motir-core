import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { RoadmapNodeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// Integration tests for the project ROADMAP read (Subtask 7.19.2):
// workItemsService.getProjectRoadmap — reuses the single recursive-CTE forest
// read (findProjectForest) + computes per-container done/total progress in one
// in-memory pass, resolving done-ness by workflow CATEGORY. Real Postgres, no
// mocks (Yue's rule). Each test builds its own tree; the cross-workspace case
// builds two independent tenants so the tenant gate is exercised, not assumed.

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

/** Direct column poke (tests may reach the db to set state — CLAUDE.md). */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/** Find a node anywhere in the forest by identifier (depth-first). */
function findNode(nodes: RoadmapNodeDto[], identifier: string): RoadmapNodeDto | undefined {
  for (const n of nodes) {
    if (n.identifier === identifier) return n;
    const hit = findNode(n.children, identifier);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Build the canonical roadmap test forest in one fixture's project:
 *
 *   E  (epic, root)
 *   ├─ A  (story)
 *   │  ├─ A1 (subtask)  done
 *   │  └─ A2 (subtask)  todo
 *   └─ B  (story)
 *      ├─ B1 (subtask)  done
 *      ├─ B2 (subtask)  cancelled   ← excluded from done AND total
 *      └─ B3 (subtask)  in_review   ← in_progress category, NOT done
 *   X  (bug, root, leaf)  done
 *
 * Keys allocate in creation order (E=1, A=2, A1=3, A2=4, B=5, B1=6, B2=7,
 * B3=8, X=9), which equals the key-asc order the roadmap must come back in.
 *
 * Expected meters:
 *   Story A  → done 1 / total 2
 *   Story B  → done 1 / total 2   (B2 cancelled excluded; B3 in_review counts to total)
 *   Epic  E  → done 2 / total 4   (descendant leaves A1,A2,B1,B3; B2 excluded)
 */
async function buildForest(fx: WorkItemFixture) {
  const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
  const A = await createWorkItem(fx, { kind: 'story', title: 'Story A', parentId: E.id });
  const A1 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A1', parentId: A.id });
  const A2 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A2', parentId: A.id });
  const B = await createWorkItem(fx, { kind: 'story', title: 'Story B', parentId: E.id });
  const B1 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B1', parentId: B.id });
  const B2 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B2', parentId: B.id });
  const B3 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B3', parentId: B.id });
  const X = await createWorkItem(fx, { kind: 'bug', title: 'Bug X' });

  await setStatus(A1.id, 'done');
  await setStatus(A2.id, 'todo');
  await setStatus(B1.id, 'done');
  await setStatus(B2.id, 'cancelled');
  await setStatus(B3.id, 'in_review');
  await setStatus(X.id, 'done');
  return { E, A, A1, A2, B, B1, B2, B3, X };
}

describe('workItemsService.getProjectRoadmap — nesting + ordering', () => {
  it('nests the forest key-asc with per-node fields (kind/status/type/depth)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);

    // Two roots, key-asc: Epic E (PROD-1) then Bug X (PROD-9).
    expect(nodes.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-9']);

    const e = nodes[0]!;
    expect(e.kind).toBe('epic');
    expect(e.title).toBe('Epic E');
    expect(e.depth).toBe(1);
    // children key-asc: Story A (PROD-2) then Story B (PROD-5).
    expect(e.children.map((c) => c.identifier)).toEqual(['PROD-2', 'PROD-5']);

    const a = e.children[0]!;
    expect(a.kind).toBe('story');
    expect(a.depth).toBe(2);
    expect(a.children.map((c) => c.identifier)).toEqual(['PROD-3', 'PROD-4']);
    expect(a.children[0]!.depth).toBe(3);

    // A leaf carries no children.
    const x = nodes[1]!;
    expect(x.kind).toBe('bug');
    expect(x.children).toEqual([]);
  });

  it('empty project → { nodes: [] }', async () => {
    const fx = await makeFixture();
    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);
    expect(roadmap).toEqual({ nodes: [] });
  });
});

describe('workItemsService.getProjectRoadmap — progress roll-ups', () => {
  it('rolls done/total up to each story and epic over descendant leaves', async () => {
    const fx = await makeFixture();
    await buildForest(fx);

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);

    expect(findNode(nodes, 'PROD-2')!.progress).toEqual({ done: 1, total: 2 }); // Story A
    expect(findNode(nodes, 'PROD-5')!.progress).toEqual({ done: 1, total: 2 }); // Story B
    expect(findNode(nodes, 'PROD-1')!.progress).toEqual({ done: 2, total: 4 }); // Epic E
  });

  it('excludes cancelled leaves from BOTH done and total', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    // Cancel A2 too: Story A now has A1(done) + A2(cancelled) → done 1 / total 1.
    await setStatus(t.A2.id, 'cancelled');

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);
    expect(findNode(nodes, 'PROD-2')!.progress).toEqual({ done: 1, total: 1 });
    // Epic E loses A2 from its total too: leaves A1,B1,B3 counted (+B2,A2 cancelled).
    expect(findNode(nodes, 'PROD-1')!.progress).toEqual({ done: 2, total: 3 });
  });

  it('a container whose leaves are all cancelled → { done: 0, total: 0 }', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    await setStatus(t.B1.id, 'cancelled');
    await setStatus(t.B3.id, 'cancelled');
    // Story B: B1,B2,B3 all cancelled → empty meter, never held incomplete.
    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);
    expect(findNode(nodes, 'PROD-5')!.progress).toEqual({ done: 0, total: 0 });
  });

  it('leaves carry progress = null; containers carry a meter', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);

    expect(findNode(nodes, 'PROD-3')!.progress).toBeNull(); // subtask A1 (leaf)
    expect(findNode(nodes, 'PROD-9')!.progress).toBeNull(); // bug X (root leaf)
    expect(findNode(nodes, 'PROD-2')!.progress).not.toBeNull(); // story A (container)
    expect(findNode(nodes, 'PROD-1')!.progress).not.toBeNull(); // epic E (container)
  });

  it('resolves isDone by done CATEGORY (in_review is not done; cancelled is not done)', async () => {
    const fx = await makeFixture();
    await buildForest(fx);
    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);

    expect(findNode(nodes, 'PROD-3')!.isDone).toBe(true); // A1 done
    expect(findNode(nodes, 'PROD-4')!.isDone).toBe(false); // A2 todo
    expect(findNode(nodes, 'PROD-7')!.isDone).toBe(false); // B2 cancelled — NOT done
    expect(findNode(nodes, 'PROD-8')!.isDone).toBe(false); // B3 in_review — NOT done
    expect(findNode(nodes, 'PROD-9')!.isDone).toBe(true); // X done
    expect(findNode(nodes, 'PROD-1')!.isDone).toBe(false); // epic E own status todo
  });

  it('an empty story is a leaf — no meter, contributes one unit to its epic', async () => {
    const fx = await makeFixture();
    const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const empty = await createWorkItem(fx, { kind: 'story', title: 'Empty story', parentId: E.id });
    await setStatus(empty.id, 'todo');

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);
    const story = findNode(nodes, empty.identifier)!;
    expect(story.children).toEqual([]);
    expect(story.progress).toBeNull();
    // The epic counts the childless story as one (incomplete) unit.
    expect(findNode(nodes, E.identifier)!.progress).toEqual({ done: 0, total: 1 });
  });
});

describe('workItemsService.getProjectRoadmap — exclusions + tenant gate', () => {
  it('excludes archived items (and their descendants) from the forest and roll-ups', async () => {
    const fx = await makeFixture();
    const t = await buildForest(fx);
    // Archive Story B → B and its subtasks drop out; Epic E's meter shrinks to A's.
    await db.workItem.update({ where: { id: t.B.id }, data: { archivedAt: new Date() } });

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, fx.ctx);
    expect(findNode(nodes, 'PROD-5')).toBeUndefined();
    expect(findNode(nodes, 'PROD-6')).toBeUndefined();
    expect(findNode(nodes, 'PROD-1')!.children.map((c) => c.identifier)).toEqual(['PROD-2']);
    // Epic E now rolls up only Story A's leaves: done 1 / total 2.
    expect(findNode(nodes, 'PROD-1')!.progress).toEqual({ done: 1, total: 2 });
  });

  it('a cross-workspace projectId is a ProjectNotFoundError (no existence leak)', async () => {
    const fxA = await makeFixture({ name: 'Acme', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Other', identifier: 'BBB' });
    // Read project A's id under tenant B's context → 404, not an empty roadmap.
    await expect(workItemsService.getProjectRoadmap(fxA.projectId, fxB.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
