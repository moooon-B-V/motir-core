import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { backlogService, BACKLOG_PAGE_SIZE } from '@/lib/services/backlogService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, createTestProject } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story-4.1's CLOSING test subtask (Subtask 4.1.5). The per-layer suites already
// shipped under Story 4.1 prove their own slices and DEFER exactly two
// cross-cutting, data-model guarantees here (see their headers):
//
//   1. repository.test.ts / service.test.ts: the `sprint_one_active_per_project`
//      DB-level guard. The service suite only `forceState`s a SINGLE sprint
//      active (it never trips the index); nothing else creates two active
//      sprints. So the partial-unique index that backs "one active sprint per
//      project" is unproven until here. (4.4's start flow keeps the transition
//      atomic in the service; this index is the DB backstop — Story 4.1 module
//      header + the migration's own comment.)
//   2. backlog.test.ts: "The at-SCALE bounded-read proof (`db:seed:large`) ...
//      is Story 4.1.5." The shipped getBacklog tests page over ≤5 rows; the
//      finding-#57 claim that the read stays BOUNDED — and the rank write stays
//      O(1) — on a real-team-sized backlog is proven here.
//
// Real Postgres, no mocks (CLAUDE.md). Per the project's at-scale convention
// (Subtask 3.5.1's seam: "the cap predicate over 5,000+ rows ... here the seam
// lets us reach those states with TENS of rows") this seeds a backlog LARGER
// than the page caps (BACKLOG_PAGE_SIZE 50 / MAX 100) — enough to prove "one
// bounded page, never load-all" + a full multi-page cursor walk — rather than
// literally thousands of rows in a unit run. `pnpm db:seed:large` provides the
// UI-visible thousands-row variant; the bound itself is the same predicate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Activate a sprint through the repository's required-`tx` write. */
function activate(sprintId: string): Promise<unknown> {
  return db.$transaction((tx) => sprintRepository.update(sprintId, { state: 'active' }, tx));
}

describe('sprint_one_active_per_project (partial unique index — the DB backstop)', () => {
  it('rejects a SECOND active sprint in the same project, whether activated or created active', async () => {
    const fx = await makeWorkItemFixture({ name: 'OneActive' });

    // Two planned sprints in the SAME project (legal — the index only constrains
    // rows WHERE state = 'active').
    const first = await db.$transaction((tx) =>
      sprintRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, name: 'Sprint 1', sequence: 1 },
        tx,
      ),
    );
    const second = await db.$transaction((tx) =>
      sprintRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, name: 'Sprint 2', sequence: 2 },
        tx,
      ),
    );

    // First activation is fine.
    await activate(first.id);
    expect((await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId))?.id).toBe(
      first.id,
    );

    // Activating the SECOND while the first is active violates the partial
    // unique index (Postgres unique_violation / Prisma P2002).
    await expect(activate(second.id)).rejects.toThrow();

    // Creating a THIRD sprint directly in the `active` state is likewise rejected.
    await expect(
      db.$transaction((tx) =>
        sprintRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            name: 'Sprint 3',
            sequence: 3,
            state: 'active',
          },
          tx,
        ),
      ),
    ).rejects.toThrow();

    // The first sprint is STILL the single active one — the failed writes left
    // the invariant intact.
    const actives = await db.sprint.findMany({
      where: { projectId: fx.projectId, state: 'active' },
    });
    expect(actives.map((s) => s.id)).toEqual([first.id]);
  });

  it('allows one active sprint PER project concurrently across different projects', async () => {
    const fx = await makeWorkItemFixture({ name: 'PerProject' });
    // A second project in the SAME workspace.
    const projectB = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRJB',
    });

    const a = await db.$transaction((tx) =>
      sprintRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          name: 'A1',
          sequence: 1,
          state: 'active',
        },
        tx,
      ),
    );
    // A different project may activate its own sprint at the same time — the
    // index is scoped to (project_id), not the workspace.
    const b = await db.$transaction((tx) =>
      sprintRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: projectB.id,
          name: 'B1',
          sequence: 1,
          state: 'active',
        },
        tx,
      ),
    );

    expect((await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId))?.id).toBe(
      a.id,
    );
    expect((await sprintRepository.findActiveByProject(projectB.id, fx.workspaceId))?.id).toBe(
      b.id,
    );
  });
});

describe('bounded backlog at scale (finding #57 — never load-all, O(1) rank write)', () => {
  // ~2.4× the default page size and >MAX, so a single read can NEVER return the
  // whole set however the limit is requested.
  const SCALE = 120;

  /** Seed `n` backlog issues through the REAL create path so each gets a
   *  create-time `backlogRank` appended — returns their ids in ascending rank
   *  (== creation) order. */
  async function seedLargeBacklog(fx: WorkItemFixture, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `Scale ${String(i).padStart(4, '0')}` },
        fx.ctx,
      );
      ids.push(item.id);
    }
    return ids;
  }

  it('keeps the read bounded (one page + count) however large the limit, walks the full order by cursor, and ranks O(1)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Scale' });
    const ids = await seedLargeBacklog(fx, SCALE);

    // (1) The DEFAULT read returns ONE bounded page (BACKLOG_PAGE_SIZE), not
    //     all SCALE rows — and carries the true total for the "N issues" header.
    const def = await backlogService.getBacklog(fx.projectId, {}, fx.ctx);
    expect(def.items).toHaveLength(BACKLOG_PAGE_SIZE);
    expect(def.totalCount).toBe(SCALE);
    expect(def.nextCursor).not.toBeNull();
    expect(def.items.map((i) => i.id)).toEqual(ids.slice(0, BACKLOG_PAGE_SIZE));

    // (2) Even an absurd requested limit is clamped — the read still never
    //     loads the whole backlog (the finding-#57 "load-all" guard).
    const huge = await backlogService.getBacklog(fx.projectId, { limit: 100_000 }, fx.ctx);
    expect(huge.items.length).toBeLessThan(SCALE);
    expect(huge.totalCount).toBe(SCALE);
    expect(huge.nextCursor).not.toBeNull();

    // (3) The cursor walks the WHOLE rank ordering deterministically, one
    //     bounded page at a time — and reconstructs the exact creation order.
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await backlogService.getBacklog(
        fx.projectId,
        { limit: 50, cursor: cursor ?? undefined },
        fx.ctx,
      );
      expect(page.items.length).toBeLessThanOrEqual(50); // no page ever loads-all
      walked.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(SCALE); // walk terminates (no cursor loop)
    } while (cursor !== null);
    expect(walked).toEqual(ids);

    // (4) A reorder on the large set is a SINGLE-row write (fractional index):
    //     move the last issue between the first two and assert exactly ONE
    //     row's rank changed.
    const before = await db.workItem.findMany({
      where: { projectId: fx.projectId, sprintId: null },
      select: { id: true, backlogRank: true },
    });
    const last = ids[ids.length - 1]!;
    await backlogService.rankIssue(last, { beforeId: ids[0]!, afterId: ids[1]! }, fx.ctx);

    const after = await db.workItem.findMany({
      where: { projectId: fx.projectId, sprintId: null },
      select: { id: true, backlogRank: true },
    });
    const beforeMap = new Map(before.map((r) => [r.id, r.backlogRank]));
    const changed = after.filter((r) => beforeMap.get(r.id) !== r.backlogRank);
    expect(changed.map((r) => r.id)).toEqual([last]); // only the moved row

    // The moved issue now sits second; the total is unchanged.
    const head = await backlogService.getBacklog(fx.projectId, { limit: 3 }, fx.ctx);
    expect(head.items.map((i) => i.id)).toEqual([ids[0], last, ids[1]]);
    expect(head.totalCount).toBe(SCALE);
  }, 60_000);
});
