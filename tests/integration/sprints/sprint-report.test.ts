import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { SprintNotFoundError } from '@/lib/sprints/errors';

// Integration tests for Subtask 4.4.4 — `sprintsService.getSprintReport`, the
// sprint report read. Real Postgres (no mocks), per CLAUDE.md. Proves the
// completed/incomplete done-category split, the points summary (committed
// baseline + completed/not-completed via the 4.3.3 roll-up), the grouped counts,
// the cursor-paginated bounded lists (finding #57 — never load-all), the
// "added during sprint" scope-change from the 1.4.6 revision trail, the active
// live-preview, the empty-done-category edge, and the finding-#26 tenancy gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Give an issue a story-point estimate directly. */
async function setPoints(itemId: string, points: number): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
}

/** Move an issue into a done-category status (the default workflow seeds
 *  `done`/`cancelled` as `category = done`). */
async function markDone(itemId: string): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { status: 'done' } });
}

/** Create one issue committed to `sprintId`, returning its id. */
async function addIssue(fx: WorkItemFixture, sprintId: string, title: string): Promise<string> {
  const issue = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await backlogService.assignToSprint(issue.id, sprintId, undefined, fx.ctx);
  return issue.id;
}

describe('sprintsService.getSprintReport', () => {
  it('previews the full completed/incomplete split, points, counts, and scope change for an ACTIVE sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);

    // Five issues committed before start: a/b/c/d estimated (3/2/5/1), e unestimated.
    const a = await addIssue(fx, sprint.id, 'a');
    const b = await addIssue(fx, sprint.id, 'b');
    const c = await addIssue(fx, sprint.id, 'c');
    const d = await addIssue(fx, sprint.id, 'd');
    const e = await addIssue(fx, sprint.id, 'e');
    await setPoints(a, 3);
    await setPoints(b, 2);
    await setPoints(c, 5);
    await setPoints(d, 1);

    await sprintsService.startSprint(sprint.id, {}, fx.ctx); // baseline: 5 issues, 11 pts

    // a + b ship; c/d/e do not. One issue (f, 4 pts) is added AFTER start. The
    // report on the still-ACTIVE sprint is the complete-modal's live preview —
    // the full split BEFORE any carry-over moves issues out.
    await markDone(a);
    await markDone(b);
    const f = await addIssue(fx, sprint.id, 'f');
    await setPoints(f, 4);

    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);

    expect(report.sprintId).toBe(sprint.id);
    expect(report.state).toBe('active');

    // Counts are grouped aggregates over the WHOLE sprint, not a page sum.
    expect(report.completed.totalCount).toBe(2);
    expect(report.completed.items.map((i) => i.id).sort()).toEqual([a, b].sort());
    expect(report.incomplete.totalCount).toBe(4);
    expect(report.incomplete.items.map((i) => i.id).sort()).toEqual([c, d, e, f].sort());

    // Points: committed = the locked baseline (11, set at start, BEFORE f was
    // added); completed = done-category sum (a+b = 5); notCompleted = live
    // remainder over all current sprint issues (c5+d1+f4 = 10; e unestimated → 0).
    expect(report.points.committed).toBe(11);
    expect(report.points.completed).toBe(5);
    expect(report.points.notCompleted).toBe(10);

    // Scope change: f was associated with the sprint AFTER startDate; a–e were not.
    expect(report.addedAfterStart).toBe(1);
  });

  it('FREEZES the completed/incomplete split + counts + points of a COMPLETED sprint, even after carry-over to the backlog empties the live membership (bug-sprint-report-incomplete-list-zero-after-carry-over)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const a = await addIssue(fx, sprint.id, 'a');
    const b = await addIssue(fx, sprint.id, 'b');
    const c = await addIssue(fx, sprint.id, 'c');
    await setPoints(a, 3);
    await setPoints(b, 2);
    await setPoints(c, 5);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx); // baseline 10 pts / 3 work items
    await markDone(a); // a ships; b + c do not
    await sprintsService.completeSprint(sprint.id, { carryOverTo: 'backlog' }, fx.ctx);

    // The carry-over really DID move b + c out of the live sprint membership…
    expect(await db.workItem.findUnique({ where: { id: b }, select: { sprintId: true } })).toEqual({
      sprintId: null,
    });
    expect(await db.workItem.findUnique({ where: { id: c }, select: { sprintId: true } })).toEqual({
      sprintId: null,
    });

    // …yet the closed sprint's report still shows them as "not completed",
    // because it reads the at-completion snapshot, not the live membership.
    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    expect(report.state).toBe('complete');
    expect(report.points.committed).toBe(10); // immutable at-start baseline
    expect(report.points.completed).toBe(3); // a shipped (3)
    expect(report.points.notCompleted).toBe(7); // b (2) + c (5) carried out, still counted
    expect(report.completed.totalCount).toBe(1);
    expect(report.completed.items.map((i) => i.id)).toEqual([a]);
    expect(report.incomplete.totalCount).toBe(2);
    expect(report.incomplete.items.map((i) => i.id).sort()).toEqual([b, c].sort());
  });

  it('freezes the report after carry-over INTO another planned sprint (the carried issues keep their frozen bucket despite being re-pointed + re-ranked)', async () => {
    const fx = await makeWorkItemFixture();
    const s1 = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    const s2 = await sprintsService.createSprint(fx.projectId, { name: 'S2' }, fx.ctx);
    const a = await addIssue(fx, s1.id, 'a');
    const b = await addIssue(fx, s1.id, 'b');
    await setPoints(a, 3);
    await setPoints(b, 4);
    await sprintsService.startSprint(s1.id, {}, fx.ctx);
    await markDone(a);
    await sprintsService.completeSprint(s1.id, { carryOverTo: { sprintId: s2.id } }, fx.ctx);

    // b is now a member of S2, not S1.
    expect(await db.workItem.findUnique({ where: { id: b }, select: { sprintId: true } })).toEqual({
      sprintId: s2.id,
    });

    const report = await sprintsService.getSprintReport(s1.id, {}, fx.ctx);
    expect(report.completed.items.map((i) => i.id)).toEqual([a]);
    expect(report.incomplete.totalCount).toBe(1);
    expect(report.incomplete.items.map((i) => i.id)).toEqual([b]);
    expect(report.points.completed).toBe(3);
    expect(report.points.notCompleted).toBe(4);
  });

  it('keeps the closed report STABLE when its issues change after close (a carried-over issue is finished elsewhere; a completed issue is reopened)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const a = await addIssue(fx, sprint.id, 'a');
    const b = await addIssue(fx, sprint.id, 'b');
    await setPoints(a, 3);
    await setPoints(b, 2);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await markDone(a); // a completed, b not
    await sprintsService.completeSprint(sprint.id, { carryOverTo: 'backlog' }, fx.ctx);

    // After close: b gets finished in the backlog, and a is reopened. Neither
    // change touches the frozen snapshot, so the closed report is unchanged
    // (Jira freezes "Completed / Not Completed" at sprint close — both buckets).
    await markDone(b);
    await db.workItem.update({ where: { id: a }, data: { status: 'todo' } });

    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    expect(report.completed.items.map((i) => i.id)).toEqual([a]);
    expect(report.incomplete.items.map((i) => i.id)).toEqual([b]);
    expect(report.points.completed).toBe(3);
    expect(report.points.notCompleted).toBe(2);
  });

  it('freezes addedAfterStart so an issue added during the sprint and then carried out is still counted', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const a = await addIssue(fx, sprint.id, 'a');
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await markDone(a);
    // f is added AFTER start and is NOT completed → it carries out on close.
    const f = await addIssue(fx, sprint.id, 'f');
    await sprintsService.completeSprint(sprint.id, { carryOverTo: 'backlog' }, fx.ctx);

    expect(await db.workItem.findUnique({ where: { id: f }, select: { sprintId: true } })).toEqual({
      sprintId: null,
    });
    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    expect(report.addedAfterStart).toBe(1); // f counted despite being carried out
    expect(report.incomplete.items.map((i) => i.id)).toEqual([f]);
  });

  it('paginates the incomplete list of a COMPLETED sprint from the frozen snapshot', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addIssue(fx, sprint.id, `issue-${i}`)); // all incomplete
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await sprintsService.completeSprint(sprint.id, { carryOverTo: 'backlog' }, fx.ctx);

    const seen = new Set<string>();
    const page1 = await sprintsService.getSprintReport(sprint.id, { limit: 2 }, fx.ctx);
    expect(page1.state).toBe('complete');
    expect(page1.incomplete.items).toHaveLength(2);
    expect(page1.incomplete.totalCount).toBe(5); // count is the full aggregate, not the page
    expect(page1.incomplete.nextCursor).not.toBeNull();
    page1.incomplete.items.forEach((i) => seen.add(i.id));

    const page2 = await sprintsService.getSprintReport(
      sprint.id,
      { limit: 2, incompleteCursor: page1.incomplete.nextCursor! },
      fx.ctx,
    );
    expect(page2.incomplete.items).toHaveLength(2);
    expect(page2.incomplete.items.some((i) => seen.has(i.id))).toBe(false); // cursor advances, no overlap
    page2.incomplete.items.forEach((i) => seen.add(i.id));

    const page3 = await sprintsService.getSprintReport(
      sprint.id,
      { limit: 2, incompleteCursor: page2.incomplete.nextCursor! },
      fx.ctx,
    );
    expect(page3.incomplete.items).toHaveLength(1);
    expect(page3.incomplete.nextCursor).toBeNull(); // last page
    page3.incomplete.items.forEach((i) => seen.add(i.id));
    expect(seen.size).toBe(5); // every snapshot row paged exactly once
  });

  it('returns total 0/null points and empty/typed lists for a wholly unestimated sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const a = await addIssue(fx, sprint.id, 'a');
    await addIssue(fx, sprint.id, 'b'); // both unestimated
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await markDone(a);

    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    // The DTO stays total — numbers, never NaN; the UI owns the "—".
    expect(report.points.committed).toBeNull(); // unestimated → null baseline
    expect(report.points.completed).toBe(0);
    expect(report.points.notCompleted).toBe(0);
    expect(report.completed.totalCount).toBe(1);
    expect(report.incomplete.totalCount).toBe(1);
  });

  it('paginates each issue list independently with a bounded page + nextCursor (finding #57)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addIssue(fx, sprint.id, `issue-${i}`)); // all incomplete
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const page1 = await sprintsService.getSprintReport(sprint.id, { limit: 2 }, fx.ctx);
    expect(page1.incomplete.items).toHaveLength(2);
    expect(page1.incomplete.totalCount).toBe(5); // count is the full aggregate, not the page
    expect(page1.incomplete.nextCursor).not.toBeNull();

    const page2 = await sprintsService.getSprintReport(
      sprint.id,
      { limit: 2, incompleteCursor: page1.incomplete.nextCursor! },
      fx.ctx,
    );
    expect(page2.incomplete.items).toHaveLength(2);
    // No overlap between page 1 and page 2 (the cursor advances).
    const p1 = new Set(page1.incomplete.items.map((i) => i.id));
    expect(page2.incomplete.items.some((i) => p1.has(i.id))).toBe(false);

    const page3 = await sprintsService.getSprintReport(
      sprint.id,
      { limit: 2, incompleteCursor: page2.incomplete.nextCursor! },
      fx.ctx,
    );
    expect(page3.incomplete.items).toHaveLength(1);
    expect(page3.incomplete.nextCursor).toBeNull(); // last page
  });

  it('tenancy: a cross-workspace report is an indistinguishable 404 (finding #26)', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const sprint = await sprintsService.createSprint(a.projectId, { name: 'A1' }, a.ctx);
    await addIssue(a, sprint.id, 'a');
    await sprintsService.startSprint(sprint.id, {}, a.ctx);

    await expect(sprintsService.getSprintReport(sprint.id, {}, b.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });

  it('reports a never-started (planned) sprint: no baseline, no scope change', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await addIssue(fx, sprint.id, 'a'); // committed but the sprint is still planned

    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    expect(report.state).toBe('planned');
    expect(report.points.committed).toBeNull(); // never started → no baseline
    expect(report.addedAfterStart).toBe(0); // no startDate to anchor "added after"
    expect(report.incomplete.totalCount).toBe(1);
    expect(report.completed.totalCount).toBe(0);
  });

  it('throws SprintNotFoundError for an unknown sprint', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      sprintsService.getSprintReport('does-not-exist', {}, fx.ctx),
    ).rejects.toBeInstanceOf(SprintNotFoundError);
  });
});

// Direct repository coverage for the empty-done-category edge (the empty-input
// guard the coverage gate requires a direct test for): a project with NO
// done-category status → nothing is complete (include over [] matches none),
// everything is incomplete (exclude over [] applies no status filter).
describe('workItemRepository done-membership reads (empty done-category set)', () => {
  it('include over [] matches nothing; exclude over [] matches every sprint issue', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await addIssue(fx, sprint.id, 'a');
    await addIssue(fx, sprint.id, 'b');

    const completedCount = await workItemRepository.countSprintIssuesByDoneMembership(
      sprint.id,
      fx.workspaceId,
      { statusKeys: [], include: true },
    );
    const incompleteCount = await workItemRepository.countSprintIssuesByDoneMembership(
      sprint.id,
      fx.workspaceId,
      { statusKeys: [], include: false },
    );
    const completedRows = await workItemRepository.findSprintIssuesByDoneMembership(
      sprint.id,
      fx.workspaceId,
      { statusKeys: [], include: true, take: 50 },
    );
    const incompleteRows = await workItemRepository.findSprintIssuesByDoneMembership(
      sprint.id,
      fx.workspaceId,
      { statusKeys: [], include: false, take: 50 },
    );

    expect(completedCount).toBe(0);
    expect(completedRows).toHaveLength(0);
    expect(incompleteCount).toBe(2);
    expect(incompleteRows).toHaveLength(2);
  });
});
