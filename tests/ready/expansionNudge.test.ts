import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Expansion nudge (Subtask 7.11.7 / MOTIR-904) — the REAL
// `workItemRepository.findExpandableStubs` + `workItemsService.computeExpansionNudge`
// over real Postgres, which is the coverage the feature shipped without (MOTIR-1744).
//
// Why this file exists, and why it must never become a re-implementation:
// the ONLY test over this path used to be `tests/expansionNudgeDecision.test.ts`,
// which declared its own local `computeDecision(readyCount, stubs)` copy of the
// service body and asserted against THAT — while its header claimed the real
// service was covered over real Postgres. So the repository's raw `$queryRaw`
// shipped with ZERO execution coverage, and its predicate
// `ws."category" NOT IN ('done', 'cancelled')` raised
// `22P02 invalid input value for enum status_category: "cancelled"` on every
// single call (`status_category` has three labels — todo | in_progress | done;
// `cancelled` is a status KEY whose category is `done`). Because
// `computeExpansionNudge` reaches the stub query only AFTER the ready count
// falls below the threshold, `GET /api/ready/nudge` returned 200/null while the
// ready set was healthy and 500'd in exactly the drained state the banner exists
// to announce. A re-implementation can never fail the way the original does, and
// raw SQL is where a wrong enum literal sails past the type-checker, the linter
// and the build — so every assertion below drives the shipped code.
//
// `createTestProject` auto-seeds the default workflow: `done` AND `cancelled`
// are both category=done; the initial status is category=todo. A childless
// `todo` epic/story is itself a ready leaf (the ready set is the dispatchable
// leaves), which is why a project of bare stubs reads as a low ready count.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

/** A childless epic/story — an expandable stub candidate. */
async function stub(
  fx: WorkItemFixture,
  opts: { title?: string; kind?: 'epic' | 'story'; priority?: Priority } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'story',
      title: opts.title ?? 'Stub story',
      priority: opts.priority,
    },
    fx.ctx,
  );
}

/** A dispatchable leaf — counts toward the ready set, never an expandable stub. */
async function leaf(fx: WorkItemFixture, title = 'Leaf task') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** Force a live status by key (the workflow seeds `done` + `cancelled` as category=done). */
async function setStatus(id: string, status: string) {
  await db.workItem.update({ where: { id }, data: { status } });
}

const stubs = (rows: Array<{ identifier: string }>) => rows.map((r) => r.identifier);

describe('findExpandableStubs — the repository read, over real Postgres', () => {
  it('EXECUTES and nominates a childless non-terminal story (MOTIR-1744: this threw 22P02)', async () => {
    const fx = await makeWorkItemFixture();
    const s = await stub(fx, { title: 'Expand me' });

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    expect(stubs(rows)).toEqual([s.identifier]);
    expect(rows[0]).toMatchObject({ title: 'Expand me', kind: 'story' });
  });

  it('nominates a childless epic too', async () => {
    const fx = await makeWorkItemFixture();
    const e = await stub(fx, { kind: 'epic', title: 'Bare epic' });

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    expect(stubs(rows)).toEqual([e.identifier]);
    expect(rows[0]?.kind).toBe('epic');
  });

  it('excludes an item whose status is in the done CATEGORY — the done key AND the cancelled key', async () => {
    const fx = await makeWorkItemFixture();
    const open = await stub(fx, { title: 'Still open' });
    const finished = await stub(fx, { title: 'Finished' });
    const dropped = await stub(fx, { title: 'Dropped' });
    await setStatus(finished.id, 'done');
    // `cancelled` is a status KEY whose CATEGORY is `done` — the assertion that
    // would have failed had the predicate compared the key instead.
    await setStatus(dropped.id, 'cancelled');

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    expect(stubs(rows)).toEqual([open.identifier]);
  });

  it('keeps an in_progress stub — only the done category is terminal', async () => {
    const fx = await makeWorkItemFixture();
    const started = await stub(fx, { title: 'Started but unexpanded' });
    await setStatus(started.id, 'in_progress');

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    expect(stubs(rows)).toEqual([started.identifier]);
  });

  it('excludes a CONTAINER (a story that already has a live child), and re-includes it once the child is archived', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await stub(fx, { title: 'Already expanded' });
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Its child', parentId: parent.id },
      fx.ctx,
    );

    expect(
      stubs(await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId)),
    ).toEqual([]);

    await db.workItem.update({ where: { id: child.id }, data: { archivedAt: new Date() } });

    expect(
      stubs(await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId)),
    ).toEqual([parent.identifier]);
  });

  it('excludes leaf kinds (task / bug) and archived rows', async () => {
    const fx = await makeWorkItemFixture();
    await leaf(fx, 'A task');
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'A bug' },
      fx.ctx,
    );
    const gone = await stub(fx, { title: 'Archived stub' });
    await db.workItem.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    expect(rows).toEqual([]);
  });

  it('orders priority DESC, key ASC and caps the nomination list at 5', async () => {
    const fx = await makeWorkItemFixture();
    const s1 = await stub(fx, { title: 'medium', priority: 'medium' });
    const s2 = await stub(fx, { title: 'highest A', priority: 'highest' });
    const s3 = await stub(fx, { title: 'low', priority: 'low' });
    const s4 = await stub(fx, { title: 'highest B', priority: 'highest' });
    await stub(fx, { title: 'lowest', priority: 'lowest' });
    const s6 = await stub(fx, { title: 'high', priority: 'high' });

    const rows = await workItemRepository.findExpandableStubs(fx.projectId, fx.workspaceId);

    // Priority first (highest → lowest), key ascending inside a priority bucket
    // (s2 before s4), and the sixth stub — `lowest` — falls off the LIMIT 5.
    expect(stubs(rows)).toEqual([
      s2.identifier,
      s4.identifier,
      s6.identifier,
      s1.identifier,
      s3.identifier,
    ]);
  });

  it('is scoped to the project + workspace — another tenant’s stubs never leak in', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const own = await stub(mine, { title: 'Mine' });
    await stub(theirs, { title: 'Theirs' });

    const rows = await workItemRepository.findExpandableStubs(mine.projectId, mine.workspaceId);

    expect(stubs(rows)).toEqual([own.identifier]);
  });
});

describe('computeExpansionNudge — the real service, over real Postgres', () => {
  it('returns a nudge naming the nominated stub when the ready set is below the threshold', async () => {
    const fx = await makeWorkItemFixture();
    const s = await stub(fx, { title: 'Expand me' });
    await leaf(fx);

    const nudge = await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx);

    // The stub is itself a childless todo leaf, so the ready set is {stub, task}.
    expect(nudge).toEqual({
      readyCount: 2,
      nominatedKey: s.identifier,
      nominatedTitle: 'Expand me',
      threshold: 3,
    });
  });

  it('suppresses when the ready set is healthy — a stub exists but is not needed', async () => {
    const fx = await makeWorkItemFixture();
    await stub(fx, { title: 'Expand me' });
    await leaf(fx, 'One');
    await leaf(fx, 'Two');
    await leaf(fx, 'Three');

    expect(await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx)).toBeNull();
  });

  it('suppresses when no expandable stub exists (no false nag)', async () => {
    const fx = await makeWorkItemFixture();
    await leaf(fx, 'One');
    await leaf(fx, 'Two');

    expect(await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx)).toBeNull();
  });

  it('suppresses when the only epic/story stubs are terminal (done / cancelled)', async () => {
    const fx = await makeWorkItemFixture();
    const finished = await stub(fx, { title: 'Finished' });
    const dropped = await stub(fx, { title: 'Dropped' });
    await setStatus(finished.id, 'done');
    await setStatus(dropped.id, 'cancelled');

    expect(await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx)).toBeNull();
  });

  it('reports readyCount 0 when the ready set has fully DRAINED but a stub remains', async () => {
    const fx = await makeWorkItemFixture();
    const s = await stub(fx, { title: 'Last hope' });
    const blocker = await leaf(fx, 'In flight');
    await workItemsService.linkWorkItems(
      { fromId: s.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // An in_progress blocker is itself not ready (category in_progress) and holds
    // the stub out of the ready set — nothing is startable.
    await setStatus(blocker.id, 'in_progress');

    const nudge = await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx);

    expect(nudge).toMatchObject({ readyCount: 0, nominatedKey: s.identifier });
  });

  it('nominates the highest-priority stub, not the lowest-keyed one', async () => {
    const fx = await makeWorkItemFixture();
    await stub(fx, { title: 'Low priority, created first', priority: 'low' });
    const best = await stub(fx, { title: 'High priority, created second', priority: 'highest' });

    const nudge = await workItemsService.computeExpansionNudge(fx.projectId, fx.ctx);

    expect(nudge?.nominatedKey).toBe(best.identifier);
    expect(nudge?.nominatedTitle).toBe('High priority, created second');
  });

  it('rejects a project in another workspace (no existence leak)', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await stub(theirs, { title: 'Theirs' });

    await expect(
      workItemsService.computeExpansionNudge(theirs.projectId, mine.ctx),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
