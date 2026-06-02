import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../../helpers/db';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';

// Subtask 2.1.4 — the Story-2.1 CI gate: ONE cross-cutting integration test
// that walks the whole issue-type story end to end against a REAL Postgres
// (Yue's no-mocks rule) — type → validate → key — in the order a real caller
// hits it. It is deliberately a coherent narrative, NOT a re-run of the
// exhaustive per-aspect suites that already ship:
//
//   • the full 30-cell kind-parent matrix (service path) ....... kind-parent-matrix.test.ts (1.4.7)
//   • the direct-repo DB-trigger rejection (2 cells) ........... repository.test.ts (1.4.2)
//   • the 8- and 20-wide concurrent key-allocation stress ...... service.test.ts (1.4.4 / 1.4.7)
//   • the pure type-metadata + canParent predicates ........... tests/issues/issueTypes.test.ts (2.1.1)
//   • the pure assertValidParent gate + single-source guard ... tests/issues/parentValidation.test.ts (2.1.2)
//   • no-key-recycle-after-archive ............................ service.test.ts (2.1.3)
//
// What this file adds is the *integration-level coherence* none of those prove
// on its own: that a single project, driven through workItemsService, lets an
// operator build the canonical epic → story → task → bug tree with sequential
// keys, rejects an illegal parent at BOTH the service gate (the typed error
// the _test route maps to HTTP 422) AND the DB trigger backstop, and keeps
// keys distinct under parallel creates. Story 2.1's verification recipe runs
// exactly this walk; this is its automated form and the Story's CI gate.
//
// Placement note (2.1.4): this is a DB-backed integration test, so it lives
// with its siblings under tests/integration/work-items/ — the repo's
// unit-vs-integration split keeps tests/issues/ pure-unit. The shared fixtures
// (makeWorkItemFixture / createTestWorkItem, 1.4.7) are the same primitives
// the matrix/service/repository suites build on.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('Story 2.1 — issue types end to end (type → validate → key)', () => {
  it('builds the canonical epic → story → task → bug tree, each create succeeding with a sequential, gap-free key', async () => {
    const fx = await makeWorkItemFixture();

    // The legal 4-deep chain from the kind-parent matrix (epic→story→task→bug),
    // which is also exactly the depth limit — every link is a legal parent pair
    // AND the deepest tree the depth trigger permits.
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Checkout revamp' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Guest checkout', parentId: epic.id },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Wire the address form', parentId: story.id },
      fx.ctx,
    );
    const bug = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Zip field rejects 5+4', parentId: task.id },
      fx.ctx,
    );

    // The per-project counter (2.1.3 / 1.4.4) hands out 1..4 in creation order
    // and derives the PROD-<n> identifier from it.
    expect([epic.key, story.key, task.key, bug.key]).toEqual([1, 2, 3, 4]);
    expect([epic.identifier, story.identifier, task.identifier, bug.identifier]).toEqual([
      'PROD-1',
      'PROD-2',
      'PROD-3',
      'PROD-4',
    ]);

    // The tree wiring the kinds imply: the epic is the root, each child hangs
    // off the one above it.
    expect(epic.parentId).toBeNull();
    expect(story.parentId).toBe(epic.id);
    expect(task.parentId).toBe(story.id);
    expect(bug.parentId).toBe(task.id);
    expect([epic.kind, story.kind, task.kind, bug.kind]).toEqual(['epic', 'story', 'task', 'bug']);
  });

  it('rejects an illegal parent at the SERVICE layer with the typed error the route maps to HTTP 422, persisting nothing', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Root' },
      fx.ctx,
    );

    // An epic is root-only — it may never be parented. The service pre-flight
    // (assertValidParent) must throw BEFORE the row is written.
    const attempt = workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Nested epic', parentId: epic.id },
      fx.ctx,
    );
    await expect(attempt).rejects.toBeInstanceOf(IllegalParentTypeError);

    // The `code` discriminant is what app/api/_test/work-items/route.ts ·
    // mapError() turns into a 422 — pinning the AC's "rejected at the service
    // (422)" to the actual transport contract.
    let caught: unknown;
    try {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'epic', title: 'Nested epic', parentId: epic.id },
        fx.ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalParentTypeError);
    expect((caught as IllegalParentTypeError).code).toBe('ILLEGAL_PARENT_TYPE');

    // The gate is fail-closed: only the root epic exists; no nested epic leaked
    // past the pre-flight.
    const rows = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('epic');
  });

  it('rejects the same illegal parent at the DB layer — the trigger fires on a direct repository write that bypasses the service gate', async () => {
    const fx = await makeWorkItemFixture();

    // createTestWorkItem writes straight through the repository (the
    // allocate-key-then-create dance) with NO assertValidParent pre-flight, so
    // this drives the Postgres trigger (enforce_work_item_kind_parent) as the
    // structural backstop. The repository edge translates the trigger's
    // SQLSTATE 23514 marker into the SAME typed IllegalParentTypeError the
    // service layer would throw — proving "both layers reject" is not just the
    // service gate doing the work.
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Root' });
    const attempt = createTestWorkItem(fx, {
      kind: 'epic',
      title: 'Nested epic',
      parentId: epic.id,
    });
    await expect(attempt).rejects.toBeInstanceOf(IllegalParentTypeError);
  });

  it('hands out distinct, contiguous keys when issues are created in parallel', async () => {
    const fx = await makeWorkItemFixture();
    const N = 12;

    // Parallel creates against one project race on the per-project counter; the
    // atomic UPDATE … RETURNING under the row lock (allocateWorkItemNumber)
    // guarantees every create still gets its own key, with no gaps or dups.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        workItemsService.createWorkItem(
          { projectId: fx.projectId, kind: 'task', title: `Parallel ${i}` },
          fx.ctx,
        ),
      ),
    );

    const keys = results.map((r) => r.key);
    expect(new Set(keys).size).toBe(N); // distinct
    expect([...keys].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // contiguous 1..N
    expect(new Set(results.map((r) => r.identifier)).size).toBe(N);
  });
});
