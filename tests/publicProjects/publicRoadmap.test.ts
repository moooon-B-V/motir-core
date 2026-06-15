import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { usersService } from '@/lib/services/usersService';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the Story 6.12 · Subtask 6.12.7 public-roadmap
// reads on workItemRepository (the per-file coverage-gated file). Real Postgres,
// no DB mocks; the truncate helper CASCADE-resets between tests.
//
// The roadmap maps the project's workflow statuses to four PUBLIC buckets:
//   • Submitted  — still-in-triage public requests (triagedAt set +
//                  submittedByUserId set, non-declined, non-snoozed);
//   • Planned    — todo-category statuses (todo / blocked);
//   • In progress— in_progress-category statuses (in_progress / in_review);
//   • Done       — done-category EXCEPT `cancelled`.
// Each card carries its upvote `voteCount` (the demand-first sort key) + the
// viewer's `voted` flag. Columns are cursor-paginated `(voteCount DESC, recency
// DESC, id ASC)`.

let userCounter = 0;
async function makeUser(name: string) {
  userCounter += 1;
  return usersService.createUser({
    email: `rm-${userCounter}@ex.com`,
    password: 'hunter2hunter2',
    name,
  });
}

/** Force a work item's status key directly (a read test doesn't transition). */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/**
 * Mark an item as a still-in-triage PUBLIC request (triaged + attributed). Also
 * sets a real active workflow status (`todo`) — a production submission is
 * created through `workItemsService` at the workflow's initial status, whereas
 * the repo-level fixture leaves the raw schema default (`open`, which has no
 * `workflow_status` row), so the Submitted read's category JOIN would miss it.
 */
async function markSubmittedRequest(
  id: string,
  submittedByUserId: string,
  patch: { snoozedUntil?: Date } = {},
): Promise<void> {
  await db.workItem.update({
    where: { id },
    data: { triagedAt: new Date(), submittedByUserId, status: 'todo', ...patch },
  });
}

/** Add `n` distinct-account upvotes to a request (the demand signal). */
async function addVotes(workItemId: string, voterIds: string[]): Promise<void> {
  for (const userId of voterIds) {
    await db.publicRequestVote.create({ data: { workItemId, userId } });
  }
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('workItemRepository.findPublicRoadmapSubmitted (6.12.7)', () => {
  it('returns active in-triage public requests, highest-demand first, with the viewer vote flag', async () => {
    const fx = await makeWorkItemFixture();
    const submitter = await makeUser('Submitter');
    const viewer = await makeUser('Viewer');
    const otherVoter = await makeUser('Other');

    // Two public requests; `hot` has more votes than `cold` → must sort first.
    const cold = await createTestWorkItem(fx, { kind: 'task', title: 'cold request' });
    await markSubmittedRequest(cold.id, submitter.id);
    await addVotes(cold.id, [otherVoter.id]);

    const hot = await createTestWorkItem(fx, { kind: 'bug', title: 'hot request' });
    await markSubmittedRequest(hot.id, submitter.id);
    await addVotes(hot.id, [viewer.id, otherVoter.id]); // viewer voted here

    const rows = await workItemRepository.findPublicRoadmapSubmitted(fx.projectId, fx.workspaceId, {
      limit: 10,
      voterUserId: viewer.id,
    });

    expect(rows.map((r) => r.title)).toEqual(['hot request', 'cold request']);
    expect(rows[0]).toMatchObject({ voteCount: 2, voted: true });
    expect(rows[1]).toMatchObject({ voteCount: 1, voted: false });
  });

  it('excludes non-triage, archived, un-attributed, declined (done) and snoozed requests', async () => {
    const fx = await makeWorkItemFixture();
    const submitter = await makeUser('Submitter');

    // The one item that SHOULD show.
    const live = await createTestWorkItem(fx, { kind: 'task', title: 'live' });
    await markSubmittedRequest(live.id, submitter.id);

    // A normal (non-triage) item — not a submission.
    await createTestWorkItem(fx, { kind: 'task', title: 'normal' });

    // A triage item with NO submitter (a legacy/internal capture) — excluded.
    const unattributed = await createTestWorkItem(fx, { kind: 'bug', title: 'unattributed' });
    await db.workItem.update({ where: { id: unattributed.id }, data: { triagedAt: new Date() } });

    // An archived submission — excluded.
    const archived = await createTestWorkItem(fx, { kind: 'bug', title: 'archived' });
    await markSubmittedRequest(archived.id, submitter.id);
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    // A DECLINED submission (category `done` while still triaged) — excluded.
    const declined = await createTestWorkItem(fx, { kind: 'bug', title: 'declined' });
    await markSubmittedRequest(declined.id, submitter.id);
    await setStatus(declined.id, 'cancelled');

    // A SNOOZED submission — out of the active set.
    const snoozed = await createTestWorkItem(fx, { kind: 'task', title: 'snoozed' });
    await markSubmittedRequest(snoozed.id, submitter.id, {
      snoozedUntil: new Date(Date.now() + 60 * 60_000),
    });

    const rows = await workItemRepository.findPublicRoadmapSubmitted(fx.projectId, fx.workspaceId, {
      limit: 10,
      voterUserId: null,
    });
    expect(rows.map((r) => r.title)).toEqual(['live']);
    expect(rows[0]?.voted).toBe(false); // null viewer → never voted
  });

  it('pages after a cursor (seek-after, no overlap)', async () => {
    const fx = await makeWorkItemFixture();
    const submitter = await makeUser('Submitter');
    for (const title of ['req a', 'req b', 'req c']) {
      const wi = await createTestWorkItem(fx, { kind: 'task', title });
      await markSubmittedRequest(wi.id, submitter.id);
    }

    const page1 = await workItemRepository.findPublicRoadmapSubmitted(
      fx.projectId,
      fx.workspaceId,
      {
        limit: 1,
        voterUserId: null,
      },
    );
    expect(page1).toHaveLength(1);
    const last = page1[0]!;

    const page2 = await workItemRepository.findPublicRoadmapSubmitted(
      fx.projectId,
      fx.workspaceId,
      {
        limit: 10,
        voterUserId: null,
        cursor: { voteCount: last.voteCount, recency: last.triagedAt as Date, id: last.id },
      },
    );
    expect(page2.map((r) => r.id)).not.toContain(last.id);
    expect(page2).toHaveLength(2);
  });
});

describe('workItemRepository.countPublicRoadmapSubmitted (6.12.7)', () => {
  it('counts only active, attributed, in-triage requests', async () => {
    const fx = await makeWorkItemFixture();
    const submitter = await makeUser('Submitter');

    for (const title of ['r1', 'r2']) {
      const wi = await createTestWorkItem(fx, { kind: 'task', title });
      await markSubmittedRequest(wi.id, submitter.id);
    }
    // Declined → excluded.
    const declined = await createTestWorkItem(fx, { kind: 'bug', title: 'declined' });
    await markSubmittedRequest(declined.id, submitter.id);
    await setStatus(declined.id, 'done');

    const count = await workItemRepository.countPublicRoadmapSubmitted(
      fx.projectId,
      fx.workspaceId,
    );
    expect(count).toBe(2);
  });

  it('returns 0 for a project with no submissions', async () => {
    const fx = await makeWorkItemFixture();
    const count = await workItemRepository.countPublicRoadmapSubmitted(
      fx.projectId,
      fx.workspaceId,
    );
    expect(count).toBe(0);
  });
});

describe('workItemRepository.findPublicRoadmapByStatus (6.12.7)', () => {
  async function seedPromoted(fx: WorkItemFixture) {
    const planned = await createTestWorkItem(fx, { kind: 'story', title: 'planned story' });
    await setStatus(planned.id, 'todo');
    const inProgress = await createTestWorkItem(fx, { kind: 'task', title: 'wip task' });
    await setStatus(inProgress.id, 'in_progress');
    const doneItem = await createTestWorkItem(fx, { kind: 'task', title: 'shipped' });
    await setStatus(doneItem.id, 'done');
    return { planned, inProgress, doneItem };
  }

  it('returns graduated items in the given status keys, demand-first, with the vote flag', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await makeUser('Viewer');
    const { planned } = await seedPromoted(fx);

    // A second planned item with more votes → leads the Planned column.
    const hotPlanned = await createTestWorkItem(fx, { kind: 'task', title: 'hot planned' });
    await setStatus(hotPlanned.id, 'blocked'); // still todo-category
    await addVotes(hotPlanned.id, [viewer.id]);

    const rows = await workItemRepository.findPublicRoadmapByStatus(
      fx.projectId,
      fx.workspaceId,
      ['todo', 'blocked'],
      { limit: 10, voterUserId: viewer.id },
    );
    expect(rows.map((r) => r.title)).toEqual(['hot planned', 'planned story']);
    expect(rows[0]).toMatchObject({ voteCount: 1, voted: true });
    expect(rows.find((r) => r.id === planned.id)?.voted).toBe(false);
  });

  it('excludes archived and triage items even when their status is in the set', async () => {
    const fx = await makeWorkItemFixture();
    const submitter = await makeUser('Submitter');

    const live = await createTestWorkItem(fx, { kind: 'task', title: 'live done' });
    await setStatus(live.id, 'done');

    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'archived done' });
    await setStatus(archived.id, 'done');
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    // A triage request that happens to be `done`-status — must NOT appear in the
    // promoted Done column (it belongs to the Submitted read, if anywhere).
    const triaged = await createTestWorkItem(fx, { kind: 'bug', title: 'triaged done' });
    await setStatus(triaged.id, 'done');
    await markSubmittedRequest(triaged.id, submitter.id);

    const rows = await workItemRepository.findPublicRoadmapByStatus(
      fx.projectId,
      fx.workspaceId,
      ['done'],
      { limit: 10, voterUserId: null },
    );
    expect(rows.map((r) => r.title)).toEqual(['live done']);
  });

  it('short-circuits to [] for an empty status-key set (a bucket mapping no live status)', async () => {
    const fx = await makeWorkItemFixture();
    await seedPromoted(fx);
    const rows = await workItemRepository.findPublicRoadmapByStatus(
      fx.projectId,
      fx.workspaceId,
      [],
      {
        limit: 10,
        voterUserId: null,
      },
    );
    expect(rows).toEqual([]);
  });

  it('pages after a cursor on the monotonic key (seek-after, no overlap)', async () => {
    const fx = await makeWorkItemFixture();
    for (const title of ['d1', 'd2', 'd3']) {
      const wi = await createTestWorkItem(fx, { kind: 'task', title });
      await setStatus(wi.id, 'done');
    }
    const page1 = await workItemRepository.findPublicRoadmapByStatus(
      fx.projectId,
      fx.workspaceId,
      ['done'],
      { limit: 1, voterUserId: null },
    );
    expect(page1).toHaveLength(1);
    const last = page1[0]!;

    const page2 = await workItemRepository.findPublicRoadmapByStatus(
      fx.projectId,
      fx.workspaceId,
      ['done'],
      {
        limit: 10,
        voterUserId: null,
        cursor: { voteCount: last.voteCount, recency: last.key, id: last.id },
      },
    );
    expect(page2.map((r) => r.id)).not.toContain(last.id);
    expect(page2).toHaveLength(2);
  });
});
