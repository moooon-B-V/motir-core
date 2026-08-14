import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { activityService } from '@/lib/services/activityService';
import { boardsService } from '@/lib/services/boardsService';
import { componentsService } from '@/lib/services/componentsService';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { entitlementsFor } from '@/lib/billing/entitlements';
import { labelsService } from '@/lib/services/labelsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { estimationService } from '@/lib/services/estimationService';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { backlogService } from '@/lib/services/backlogService';
import { plansService } from '@/lib/services/plansService';
import { workflowsService } from '@/lib/services/workflowsService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { importRepository } from '@/lib/repositories/importRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '@/tests/fixtures';
import { adminDb } from './helpers/adminDb';
import { isAppRoleTestMode } from './helpers/parallelDb';
import { truncateAuthTables } from './helpers/db';

// A tenant read reached from inside a BOUND context must run ON that context
// (MOTIR-2774).
//
// `withWorkspaceContext` / `withUserContext` / `withWorkspaceServiceContext` bind
// their GUCs with `set_config(..., true)` — TRANSACTION-local. A repository method
// that ignores the `tx` it could have taken issues its statement on the `@/lib/db`
// singleton instead, on a different connection, where the policy sees NULL. The
// read then returns ZERO ROWS AND RAISES NOTHING: an empty answer is an ordinary
// answer, so the caller reports "missing" for something that is merely unbound.
//
// That is the third occurrence of this class (MOTIR-2569, MOTIR-2685), and the
// first two were each found the same way — by running the suite under
// TEST_DB_APP_ROLE=1. These tests are the regression net.
//
// ⚠️ DELIBERATELY NOT `describe.runIf(isAppRoleTestMode())`. CI does not set the
// flag, so a gated test would never run there. Written unconditionally, each case
// passes trivially under the bypass role (the read succeeds either way) and passes
// under the app role ONLY once the `tx` is threaded — so the same test is a live
// CI path in the default mode and the discriminator in flag mode. Every one of
// them fails under the flag on the commit before this card.

/** A trivially-valid stored filter — the criteria are not what these cases test. */
const KIND_TASK_FILTER_PARAM = encodeFilterParam({
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
});

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workflowsService.getInitialStatusKey — reached by createWorkItem', () => {
  it('creates a work item that lands in the project’s initial status', async () => {
    const fx = await makeWorkItemFixture();

    // The unbound read made `getInitialStatusKey` return null, and createWorkItem
    // turned that into NoInitialStatusError — a 500 reading "corrupt seed" about a
    // project whose workflow is perfectly intact.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Bound read' },
      fx.ctx,
    );

    expect(item.id).toBeTruthy();

    // The status is the project's INITIAL one, not merely non-null: a fix that
    // defaulted the status instead of reading it would pass a null check.
    const initial = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, isInitial: true },
      select: { key: true },
    });
    const row = await adminDb.workItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { status: true },
    });
    expect(row.status).toBe(initial.key);
  });
});

describe('organizationMembershipRepository.findOrganizationsByUser — the org switcher', () => {
  it('lists the organizations the user belongs to', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-list@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    // Unbound, this returned [] and the switcher rendered empty.
    const orgs = await organizationsService.listUserOrganizations(user.id);
    expect(orgs.map((o) => o.id)).toEqual([seeded.organizationId]);
  });

  it('resolves an ACTIVE organization rather than reporting the user has none', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-active@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads Active',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    // Unbound, `orgs[0]` was undefined and this returned null — indistinguishable
    // from a user who belongs to nothing.
    const active = await organizationsService.resolveActiveOrganization(user.id);
    expect(active).not.toBeNull();
    expect(active?.organization.id).toBe(seeded.organizationId);
    // The ROLE comes from a second read in the same function; assert it so a fix
    // that bound only the first read is not mistaken for a complete one.
    expect(active?.role).toBe('owner');
  });

  it('honours a preferred organization the user is a member of', async () => {
    const user = await usersService.createUser({
      email: 'bound-reads-pinned@example.com',
      password: 'hunter2hunter2',
      name: 'Bound Reads',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bound Reads Pinned',
      ownerUserId: user.id,
    });
    const seeded = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { organizationId: true },
    });

    const active = await organizationsService.resolveActiveOrganization(
      user.id,
      seeded.organizationId,
    );
    expect(active?.organization.id).toBe(seeded.organizationId);
  });
});

describe('automationRuleExecutionRepository.findLatestByRuleIds — the last-run glyph', () => {
  it('reports a rule’s last run instead of an empty glyph', async () => {
    const fx = await makeWorkItemFixture();
    const rule = await automationRulesService.create(
      fx.projectIdentifier,
      {
        name: 'When a bug is done, set priority high',
        triggerType: 'transitioned',
        triggerConfig: { toStatusId: 's-done' },
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      fx.ctx,
    );

    // One execution row, seeded through the ADMIN client — the point under test is
    // the READ, and seeding through the runtime would make the fixture depend on the
    // automation engine having run.
    //
    // `automation_rule_execution` carries no `workspaceId` of its own: it is scoped
    // through its rule, and its RLS policy joins to reach the tenant. That is exactly
    // why the singleton read was invisible rather than obviously wrong — the table
    // has no tenant column to notice missing.
    await adminDb.automationRuleExecution.create({
      data: { ruleId: rule.id, status: 'success' },
    });

    // `list` opens withWorkspaceContext and then read the executions off the
    // singleton, so `latest` came back empty and EVERY rule rendered with no
    // last-run glyph — a project that looks like it has never run a rule.
    const rules = await automationRulesService.list(fx.projectIdentifier, fx.ctx);
    const listed = rules.find((r) => r.id === rule.id);
    expect(listed).toBeDefined();
    expect(listed?.lastRun).not.toBeNull();
    expect(listed?.lastRun?.status).toBe('success');
  });
});

describe('workItemLinkRepository.findById — reached by unlinkWorkItems', () => {
  it('removes a link the caller can see', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'B' },
      fx.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // `unlinkWorkItems` opens withWorkspaceContext and then read the link off the
    // singleton, so the link it had just been handed came back null and the call
    // threw WorkItemLinkNotFoundError. Unlinking was impossible under the role.
    await expect(workItemsService.unlinkWorkItems(link.id, fx.ctx)).resolves.toBeUndefined();

    const remaining = await adminDb.workItemLink.findUnique({ where: { id: link.id } });
    expect(remaining).toBeNull();
  });
});

// ── MOTIR-2805 · savedFiltersService ──────────────────────────────────────────
//
// The second of the two services that contained ZERO context wrappers anywhere
// in the file. Unbound, `listPage` / `countVisible` / `countByFilter` each
// returned the empty answer and nothing raised, so every user's saved-filter
// directory was empty and every delete warned about zero dependents.
//
// These sit here rather than in `tests/integration/saved-filters` for the reason
// this file's header gives: written unconditionally they pass trivially under the
// bypass role and are the discriminator under `TEST_DB_APP_ROLE=1`.

describe('savedFilterRepository.listPage / countVisible — the filter directory', () => {
  it('lists the project’s filters WITH a total that agrees with the page', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFA' });
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await savedFiltersService.create(
        fx.projectIdentifier,
        { name, visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
        fx.ctx,
      );
    }

    const page = await savedFiltersService.list(fx.projectIdentifier, {}, fx.ctx);

    // Unbound, `items` was [] and `total` was 0 — a directory that renders as
    // "no saved filters" for a project that has three.
    expect(page.items.map((f) => f.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(page.total).toBe(3);
    // The page and its count are separate reads presented as one answer. Two
    // transactions can disagree ("1–20 of 0"); one cannot.
    expect(page.total).toBe(page.items.length);
  });

  it('pages and counts consistently when the page is smaller than the total', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFB' });
    for (const name of ['One', 'Two', 'Three']) {
      await savedFiltersService.create(
        fx.projectIdentifier,
        { name, visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
        fx.ctx,
      );
    }

    const page = await savedFiltersService.list(fx.projectIdentifier, { limit: 2 }, fx.ctx);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    // The TOTAL is the whole visible set, not the page — the assertion that
    // catches a count read in a different snapshot from the page.
    expect(page.total).toBe(3);
  });
});

describe('savedFilterSubscriptionRepository.countByFilter — the delete warning', () => {
  it('counts the subscriptions a delete would remove', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFC' });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'Watched', visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
      fx.ctx,
    );
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'daily', hour: 9 },
      fx.ctx,
    );

    // Unbound this returned 0, so the delete dialog promised nothing would be
    // lost while a live subscription was about to be cascaded away.
    const dependents = await savedFiltersService.getDependents(
      fx.projectIdentifier,
      filter.id,
      fx.ctx,
    );
    expect(dependents.subscriptionCount).toBe(1);
  });

  it('reads back the actor’s own subscription rather than reporting none', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFD' });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'Mine', visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
      fx.ctx,
    );
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'weekly', weekday: 2, hour: 8 },
      fx.ctx,
    );

    // `getMine` resolved the project through an unbound read, so it threw
    // ProjectNotFoundError for a project the actor owns.
    const mine = await savedFilterSubscriptionsService.getMine(
      fx.projectIdentifier,
      filter.id,
      fx.ctx,
    );
    expect(mine).toEqual({ schedule: 'weekly', weekday: 2, hour: 8 });
  });
});

// ── MOTIR-2800 · reportsService ───────────────────────────────────────────────
//
// The first of the two services that contained ZERO context wrappers anywhere in
// the file. Unbound, every aggregate returned an empty result set and the charts
// drew flat zero lines — no error, no log, just a project that appears to hold
// no work at all.
//
// ⚠️ EVERY ASSERTION BELOW IS ON PRESENCE OF SPECIFIC SEEDED DATA. A report
// asserting a count of zero passes VACUOUSLY under the app role, which is the
// exact failure mode this story exists to remove, so an assertion shaped like
// `expect(rows.length).toBeGreaterThanOrEqual(0)` would be worse than no test.

describe('reportsService — the aggregates that drew flat zero lines', () => {
  /**
   * One open item (assigned, 5 points) and one item resolved two days ago. The
   * resolution is seeded as a REVISION through `adminDb` rather than driven
   * through `updateStatus`, for the reason the reports suite does the same: the
   * done-category series read the 1.4.6 trail, and the trail is the fixture.
   */
  async function seedReportable(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const assignee = await usersService.createUser({
      email: `reports-${identifier.toLowerCase()}@example.com`,
      password: 'hunter2hunter2',
      name: `Reporter ${identifier}`,
    });
    const open = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Open work' },
      fx.ctx,
    );
    const closed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Closed work' },
      fx.ctx,
    );
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await adminDb.workItem.update({
      where: { id: open.id },
      data: { assigneeId: assignee.id, storyPoints: 5, createdAt: fourDaysAgo },
    });
    await adminDb.workItem.update({
      where: { id: closed.id },
      data: { createdAt: fourDaysAgo },
    });
    await adminDb.workItemRevision.create({
      data: {
        workItemId: closed.id,
        changedById: fx.ownerId,
        changeKind: 'updated',
        changedAt: twoDaysAgo,
        diff: { status: { from: 'todo', to: 'done' } },
      },
    });
    await adminDb.workItem.update({ where: { id: closed.id }, data: { status: 'done' } });
    return { fx, assigneeName: `Reporter ${identifier}` };
  }

  it('getWorkload returns the assignee’s open points, not an empty ranking', async () => {
    const { fx, assigneeName } = await seedReportable('RPA');

    const result = await reportsService.getWorkload(
      { projectId: fx.projectId },
      { measure: 'story_points' },
      fx.ctx,
    );

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');
    expect(result.data.assignees.map((a) => [a.name, a.points])).toContainEqual([assigneeName, 5]);
  });

  it('getDistribution returns populated kind segments, not an empty donut', async () => {
    const { fx } = await seedReportable('RPB');

    const result = await reportsService.getDistribution(
      { projectId: fx.projectId },
      'kind',
      fx.ctx,
    );

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');
    const byId = new Map(result.data.segments.map((seg) => [seg.id, seg.count]));
    expect(byId.get('task')).toBe(1);
    expect(byId.get('bug')).toBe(1);
    expect(result.data.total).toBe(2);
  });

  it('getCreatedVsResolved returns both series populated in one snapshot', async () => {
    const { fx } = await seedReportable('RPC');

    const result = await reportsService.getCreatedVsResolved(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7, cumulative: false },
      fx.ctx,
    );

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');
    // Two seeded items, one of them transitioned into a done-category status.
    // Both series come from DIFFERENT repositories in the SAME transaction.
    expect(result.data.buckets.reduce((n, b) => n + b.created, 0)).toBe(2);
    expect(result.data.buckets.reduce((n, b) => n + b.resolved, 0)).toBe(1);
  });

  it('getAverageAge counts the still-open item rather than reporting no open work', async () => {
    const { fx } = await seedReportable('RPD');

    const result = await reportsService.getAverageAge(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7 },
      fx.ctx,
    );

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');
    const latest = result.data.buckets[result.data.buckets.length - 1];
    // Exactly the OPEN item: the resolved one drops out of a point-in-time read.
    expect(latest?.count).toBe(1);
    expect(result.data.windowAverage).not.toBeNull();
  });

  it('getResolutionTime counts the resolved item rather than an empty bar', async () => {
    const { fx } = await seedReportable('RPE');

    const result = await reportsService.getResolutionTime(
      { projectId: fx.projectId },
      { period: 'day', daysBack: 7 },
      fx.ctx,
    );

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');
    expect(result.data.buckets.reduce((n, b) => n + b.count, 0)).toBe(1);
    expect(result.data.windowAverage).not.toBeNull();
  });
});

// ── MOTIR-2804 · sprintsService + estimationService ───────────────────────────
//
// A completed sprint's report is read from the FROZEN `sprint_report_entry`
// snapshot, and the velocity chart sums the same table through
// `estimationService`. Unbound, all of it read as a team that did nothing: zero
// completed, zero added mid-sprint, a velocity of zero — and the zero then feeds
// the estimation surface, so the wrong number travels one layer further than the
// report that produced it.
//
// ⚠️ THESE ARE SUMS AND COUNTS, which is why they are asserted against seeded
// values rather than for non-emptiness. `expect(velocity).toBe(0)` is what an
// unbound read passes; only a specific figure separates "the team completed
// nothing" from "the query could not see the rows".

describe('estimationService + sprintsService — the frozen sprint report', () => {
  /** A COMPLETED sprint carrying a two-row snapshot: one done (5 pts), one not. */
  async function seedCompletedSprint(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const sprint = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Closed sprint',
        state: 'complete',
        sequence: 1,
        completedAt: new Date(),
        committedPoints: 8,
        committedIssueCount: 2,
      },
    });
    const done = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Finished' },
      fx.ctx,
    );
    const open = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Carried over' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: done.id },
      data: { sprintId: sprint.id, storyPoints: 5, status: 'done' },
    });
    await adminDb.workItem.update({
      where: { id: open.id },
      data: { sprintId: sprint.id, storyPoints: 3 },
    });
    await adminDb.sprintReportEntry.createMany({
      data: [
        {
          workspaceId: fx.workspaceId,
          sprintId: sprint.id,
          workItemId: done.id,
          completed: true,
          addedAfterStart: false,
        },
        {
          workspaceId: fx.workspaceId,
          sprintId: sprint.id,
          workItemId: open.id,
          completed: false,
          addedAfterStart: true,
        },
      ],
    });
    return { fx, sprintId: sprint.id };
  }

  it('reports the frozen completed / incomplete split and the added-during figure', async () => {
    const { fx, sprintId } = await seedCompletedSprint('SPA');

    const report = await sprintsService.getSprintReport(sprintId, {}, fx.ctx);

    // Unbound, every one of these read 0 — a closed sprint that looks empty.
    expect(report.completed.totalCount).toBe(1);
    expect(report.incomplete.totalCount).toBe(1);
    expect(report.addedAfterStart).toBe(1);
    expect(report.completed.items.map((i) => i.title)).toEqual(['Finished']);
    expect(report.points.completed).toBe(5);
    expect(report.points.notCompleted).toBe(3);
  });

  it('rolls the sprint up to a NON-ZERO velocity input rather than a silent zero', async () => {
    const { fx, sprintId } = await seedCompletedSprint('SPB');

    const snapshot = await estimationService.rollupForSprintSnapshot(sprintId, fx.ctx);
    expect(snapshot.completed).toBe(5);
    expect(snapshot.notCompleted).toBe(3);

    // And through the chart the estimation surface actually renders. A `sum`
    // returns 0 rather than failing when the read sees nothing, so this is the
    // vacuous-pass shape the story exists to remove.
    const velocity = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(velocity.sprints).toHaveLength(1);
    expect(velocity.sprints[0]?.completed).toBe(5);
    expect(velocity.sprints[0]?.committed).toBe(8);
    expect(velocity.averageCompleted).toBe(5);
  });
});

// ── MOTIR-2801 · boardsService ────────────────────────────────────────────────
//
// The board's swimlane grouping — by assignee, by epic, by priority — is the
// feature that makes a board more than a list, and unbound every lane came back
// empty. The board still DREW its lanes; they just contained nothing.
//
// ⚠️ The plan named four reads here. The call-site scanner (MOTIR-2845) found
// TWENTY-FIVE, and the extra twenty-one are why the whole projection 404'd
// rather than merely rendering empty lanes: `boardRepository.findById` and
// `findDefaultForProject` are the FIRST reads `getBoard` makes, so under the
// role every board in the product was BoardNotFoundError before a lane was ever
// computed. That is the guard earning its move to the front of the story.

describe('boardsService — the board that could not be found and the lanes that were empty', () => {
  async function seedBoard(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const assignee = await usersService.createUser({
      email: `boards-${identifier.toLowerCase()}@example.com`,
      password: 'hunter2hunter2',
      name: `Laner ${identifier}`,
    });
    const one = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Assigned card' },
      fx.ctx,
    );
    const two = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unassigned card' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: one.id },
      data: { assigneeId: assignee.id, priority: 'high' },
    });
    await adminDb.workItem.update({ where: { id: two.id }, data: { priority: 'low' } });
    return { fx, assigneeName: `Laner ${identifier}` };
  }

  it('finds the project’s default board at all', async () => {
    const { fx } = await seedBoard('BDA');

    // Unbound this threw BoardNotFoundError — for the default board the project
    // is seeded with. Every other assertion in this block is downstream of it.
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.columns.length).toBeGreaterThan(0);
    expect(
      board.columns
        .flatMap((c) => c.cards)
        .map((c) => c.title)
        .sort(),
    ).toEqual(['Assigned card', 'Unassigned card']);
  });

  it('groups into populated ASSIGNEE lanes, not empty ones', async () => {
    const { fx, assigneeName } = await seedBoard('BDB');
    await boardsService.setSwimlaneGroupBy(
      (await boardsService.getBoard(fx.projectId, fx.ctx)).boardId,
      'assignee',
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    // Named lanes with counts — never `lanes.length >= 0`, which is what an
    // unbound aggregate satisfies.
    const byLabel = new Map(board.swimlanes.map((l) => [l.label, l.count]));
    expect(byLabel.get(assigneeName)).toBe(1);
    expect(byLabel.get('No assignee')).toBe(1);
  });

  it('groups into populated PRIORITY lanes', async () => {
    const { fx } = await seedBoard('BDC');
    await boardsService.setSwimlaneGroupBy(
      (await boardsService.getBoard(fx.projectId, fx.ctx)).boardId,
      'priority',
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    const byKey = new Map(board.swimlanes.map((l) => [l.key, l.count]));
    expect(byKey.get('high')).toBe(1);
    expect(byKey.get('low')).toBe(1);
  });
});

// ── MOTIR-2807 · workItemRepository.findByIds ─────────────────────────────────
//
// ONE read, thirteen call sites, five services. It has its own card because the
// ratchet counts the READ: bind one caller, delete the entry, and the counter
// says "done" while twelve paths stay dark. That is the worst outcome available
// in this story, because it turns the progress measure into a lie.
//
// ⚠️ The card says fourteen. The grep finds THIRTEEN, and the card's own table
// sums to thirteen too — the prose count is off by one against its own evidence.
// Recorded rather than quietly corrected, because "if the grep now finds more,
// bind those too and say so" cuts both ways.
//
// ⚠️ AND ONE OF THE THIRTEEN IS DELIBERATELY LEFT UNBOUND —
// `publicProjectsService`'s parent lookup. See the comment at that call site:
// `work_item_public_project_read` fires only when `app.workspace_id` is UNSET,
// so binding it would switch the public page onto the private arm. It would
// probably still return the row, which is exactly why it is dangerous.

describe('workItemRepository.findByIds — one read, five consuming surfaces', () => {
  async function seedLinkedPair(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const blocked = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Needs the other one' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Must land first' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    return { fx, blocked, blocker };
  }

  it('resolves an item’s BLOCKERS rather than reporting it unblocked', async () => {
    const { fx, blocked } = await seedLinkedPair('FBA');

    // The worst failure mode in the story: unbound, the batch came back empty and
    // a blocked item reported NO blockers — not "unknown", not an error. The plan's
    // central invariant, inverted silently.
    const blockers = await workItemsService.getBlockers(blocked.id, fx.ctx);
    expect(blockers.map((b) => b.title)).toEqual(['Must land first']);
  });

  it('resolves the reverse edge — what an item is BLOCKING', async () => {
    const { fx, blocker } = await seedLinkedPair('FBB');

    const blocking = await workItemsService.getBlocking(blocker.id, fx.ctx);
    expect(blocking.map((b) => b.title)).toEqual(['Needs the other one']);
  });

  it('reads the batch through a bound tx, and returns the EMPTY answer without one', async () => {
    const { fx, blocker } = await seedLinkedPair('FBC');

    // The two arms of `tx ?? db`, side by side. The bound one is the contract;
    // the unbound one is pinned as the EMPTY answer rather than as rows, because
    // asserting rows there would be asserting that a path with no binding works.
    const bound = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByIds([blocker.id], tx),
    );
    expect(bound.map((r) => r.title)).toEqual(['Must land first']);

    const unbound = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findByIds([blocker.id], tx),
    );
    if (isAppRoleTestMode()) {
      expect(unbound).toEqual([]);
    } else {
      expect(unbound.map((r) => r.title)).toEqual(['Must land first']);
    }
  });

  // ⚠️ NOT ASSERTED HERE, and the reason is ownership rather than difficulty.
  // The item-detail panel and the dispatch prompt are the other two consuming
  // surfaces, and both open on reads this card does not own — `findByIdentifier`
  // and the five-link fan-out in `getIssueDetail`, which are MOTIR-2802's and
  // MOTIR-2803's. `findByIds` is bound at those call sites already; proving them
  // end-to-end needs those cards, and writing a test that passes only once a
  // sibling lands would report this card's state dishonestly.
});

// ── MOTIR-2806 · activityService ──────────────────────────────────────────────
//
// The activity feed hydrates the entities its events name, and counts the
// item's displayable revisions to decide whether a "show more" control appears
// at all. Unbound, the count read 0 — so an item with a long history rendered a
// short one with NO affordance to see the rest. Not a broken screen: a missing
// door, which nobody thinks to report.

describe('activityService — the feed that lost its history', () => {
  it('reports the item’s real revision total, not zero', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACT' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Has a history' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(item.id, { title: 'Renamed once' }, fx.ctx);
    await workItemsService.updateWorkItem(item.id, { title: 'Renamed twice' }, fx.ctx);

    const page = await activityService.listHistory(item.id, {}, fx.ctx);

    // A specific figure, because `toBe(0)` is what the unbound read passes and
    // `toBeGreaterThanOrEqual(0)` would pass either way. Created + two renames.
    expect(page.totalCount).toBe(3);
    expect(page.entries.length).toBe(3);
  });
});

// ── MOTIR-2802 · workItemsService, the link-edge half ─────────────────────────
//
// THE HIGHEST-CONSEQUENCE GROUP IN THE STORY, and the reason is that its failure
// does not look like one. Everywhere else an unbound read produces a visibly
// empty screen. Here an empty edge set does not render as "unknown" — it renders
// as NOT BLOCKED. So under `motir_app` a blocked item reports itself READY, and
// `claim_next_ready` hands out work whose prerequisites are unbuilt.
//
// An empty screen tells you something is wrong. A plan that says everything is
// ready looks exactly like a plan going well, and the consequence surfaces days
// later as confusing failures somewhere else.

describe('workItemsService — readiness, the invariant that fails while sounding certain', () => {
  async function seedBlockedItem(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const blocked = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Cannot start yet' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Must land first' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    return { fx, blocked, blocker };
  }

  it('an item with an OPEN blocker is NOT ready', async () => {
    const { fx, blocked, blocker } = await seedBlockedItem('RDY');

    const verdict = await workItemsService.getReadiness(blocked.id, fx.ctx);

    // Unbound, `ready` was TRUE and `openBlockerIds` was empty — the product
    // asserting, with no hedge, the opposite of the truth.
    expect(verdict.ready).toBe(false);
    expect([...verdict.openBlockerIds]).toEqual([blocker.id]);
  });

  it('and becomes ready only once the blocker actually reaches a terminal status', async () => {
    const { fx, blocked, blocker } = await seedBlockedItem('RDZ');

    // The control for the case above: a test that only ever asserts `false`
    // would pass against a service that always says `false`.
    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });

    const verdict = await workItemsService.getReadiness(blocked.id, fx.ctx);
    expect(verdict.ready).toBe(true);
    expect([...verdict.openBlockerIds]).toEqual([]);
  });

  it('reports the item’s open blockers on the RELATIONSHIPS read too', async () => {
    const { fx, blocked, blocker } = await seedBlockedItem('RDB');

    // `findBlockedEdgesForItems` / `findBlockerEdgesForItems` are the BATCHED
    // edge reads behind the list-page decoration: unbound, a whole page of items
    // renders with no dependency arrows at all.
    const edges = await workItemsService.getDependencyEdgesForItems([blocked.id], fx.ctx);
    expect(edges[blocked.id]?.blockedBy.map((e) => e.key)).toEqual([blocker.identifier]);
  });

  // ⚠️ `listReady` — the surface `claim_next_ready` actually sits on, and the
  // sharpest form of this defect — is NOT asserted here. It opens on
  // `workItemRepository.findReadyLayer`, which is MOTIR-2803's read; the edge
  // reads it then consults are bound by this card. Proving it end-to-end needs
  // that sibling, and a test that only passes once it lands would report this
  // card's state dishonestly.
});

// ── MOTIR-2803 · workItemsService, the tree / search / decoration half ────────
//
// A broader spread of small losses rather than one dramatic one: search finds
// nothing for text that is definitely there, an item's detail loses its labels
// and custom-field values, and walking a tree returns nothing so hierarchy
// features quietly flatten. Together that is most of what makes the product feel
// like it knows about your work rather than just storing it.

describe('workItemsService — search, subtree and the item’s decorations', () => {
  it('quick search FINDS a work item by title', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'QSR' });
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unmistakable haystack needle' },
      fx.ctx,
    );

    const hits = await workItemsService.quickSearch('haystack', fx.ctx);

    // The emptiness-shaped one: a search box that finds nothing is what a person
    // tries twice and then stops using.
    expect(hits.map((h) => h.title)).toEqual(['Unmistakable haystack needle']);
  });

  it('walks a BOUNDED SUBTREE rather than reporting a leaf', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SUB' });
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The container' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The child', parentId: parent.id },
      fx.ctx,
    );

    const subtree = await workItemsService.getBoundedSubtree(parent.id, fx.ctx, 2);
    expect(subtree.nodes.map((n) => n.title)).toContain('The child');
  });

  it('decorates the item DETAIL with its labels and custom-field values', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'DEC' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Decorated' },
      fx.ctx,
    );
    // Seeded through the ADMIN client: the point under test is the detail READ,
    // and `labelsService.setLabels` opens a bare `db.$transaction` of its own
    // (MOTIR-2846's), so driving the fixture through it would make this test
    // depend on a defect a different card owns.
    const label = await adminDb.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'needs-review',
        nameLower: 'needs-review',
      },
    });
    await adminDb.workItemLabel.create({
      data: { workItemId: item.id, labelId: label.id },
    });

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);

    // Not "the panel rendered": the specific label the item carries.
    expect(detail.labels.map((l) => l.name)).toEqual(['needs-review']);
  });
});

// ── MOTIR-2808 · planValidityService + planStalenessService ───────────────────
//
// The queries behind the product's OPINION of a plan: is it valid, has it gone
// stale. Unbound they gathered nothing — and a validity check over an empty set
// does not report "I could not tell". Every rule is satisfied by an absence:
// no cycles in no graph, no unsatisfied blockers among no items. So the product
// looked at a plan with real problems and pronounced it healthy.
//
// That is the confident-wrong shape, and it is worse than a blank report. A
// blank report makes someone investigate; a clean bill of health makes them
// stop looking.

describe('planValidityService — the verdict that was wrong and certain', () => {
  it('reports a subtree INVALID when a member is blocked by work outside it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'VAL' });
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The container' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Inside', parentId: story.id },
      fx.ctx,
    );
    const outsider = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Outside and not done' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: child.id, toId: outsider.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const verdict = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);

    // Unbound this returned `valid: true` with an EMPTY blocker list — the plan
    // pronounced healthy because the check could not see any of it.
    expect(verdict.valid).toBe(false);
    expect(verdict.blockers.map((b) => b.blockedBy)).toContain(outsider.identifier);
  });

  it('and reports it VALID once the outside blocker is done — the control', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'VAB' });
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The container' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Inside', parentId: story.id },
      fx.ctx,
    );
    const outsider = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Outside but finished' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: child.id, toId: outsider.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: outsider.id }, data: { status: 'done' } });

    const verdict = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(verdict.valid).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });
});

// ── MOTIR-2809 · the nine single-read services ────────────────────────────────
//
// Five are ordinary lists that came back empty. FOUR ARE GATES, and a gate fed
// an empty answer does not go blank — it DECIDES. Their measured failure modes,
// which is what this card asks for rather than "returned nothing":
//
//   organizationRepository.findCapContext — FAILS CLOSED. The repository's own
//     contract is "missing/hidden org → the safe default (bounded `free` tier,
//     caps apply)", so an org on a paid `scaled` plan was silently capped as if
//     it were free. Not a leak; a paying customer refused what they bought.
//     It also needed the ORG tier, not the workspace one: `organization_active`
//     keys on `app.organization_id`.
//
//   githubRepoRepository.findConnectedByName (oidcAuth) — FAILS CLOSED, on an
//     AUTH path. The verified `repository` claim is what determines the tenant,
//     so there is no workspace to bind; unbound the resolve matched nothing and
//     every OIDC exchange was refused `repo_not_connected`. Bound with
//     `withSystemContext` — `github_repo_workspace_or_system` has the arm.
//
//   workItemRepository.matchesAutomationCondition — FAILS CLOSED, SILENTLY. No
//     match means the rule never fires and nothing anywhere reports that it
//     didn't. An automation that has stopped working is indistinguishable from
//     one nobody triggered — the quietest failure in the whole story.
//
//   deviceCodeRepository.findByUserCodeForRead — NOT A DEFECT. `device_code` has
//     `relrowsecurity = false` and ZERO policies (measured against `pg_policies`,
//     not inferred): the scanner flagged it because the model carries a nullable
//     `workspaceId` column. Carried as `no-policy`, and binding it would be
//     actively wrong — the CLI flow has no workspace until the approver picks one.

describe('the nine single-read services', () => {
  it('componentsService lists the project’s components', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CMP' });
    await adminDb.component.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Billing',
        nameLower: 'billing',
      },
    });

    const rows = await componentsService.listComponents(fx.projectIdentifier, fx.ctx);
    expect(rows.map((c) => c.name)).toEqual(['Billing']);
  });

  it('dashboardsService lists the actor’s dashboards', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'DSH' });
    await adminDb.dashboard.create({
      data: { workspaceId: fx.workspaceId, ownerId: fx.ownerId, name: 'Delivery' },
    });

    const rows = await dashboardsService.listDashboards(fx.ctx);
    expect(rows.map((d) => d.name)).toEqual(['Delivery']);
  });

  it('labelsService autocompletes by prefix', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'LBL' });
    await adminDb.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'needs-design',
        nameLower: 'needs-design',
      },
    });

    const rows = await labelsService.searchLabels(fx.projectIdentifier, 'needs', fx.ctx);
    expect(rows.map((l) => l.name)).toEqual(['needs-design']);
  });

  it('entitlements read the org’s REAL tier rather than failing closed to free', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ENT' });
    const ws = await adminDb.workspace.findUniqueOrThrow({
      where: { id: fx.workspaceId },
      select: { organizationId: true },
    });
    await adminDb.organization.update({
      where: { id: ws.organizationId },
      data: { scaledTrackerSubscription: { status: 'active', seats: 5 } },
    });

    // The gate, through the surface that consumes it. `resolvePerFileLimitBytes`
    // short-circuits to the free limit off-cloud, so the cloud flag is set for
    // the duration — the point under test is the ORG READ, not the flag.
    const wasCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
    try {
      // Unbound the org row was invisible, `findCapContext` returned its
      // documented safe default, and a paid `scaled` org was handed the FREE
      // per-file limit — refused what it bought rather than granted what it
      // had not.
      const limit = await entitlementsService.resolvePerFileLimitBytes(ws.organizationId);
      expect(limit).toBe(entitlementsFor('scaled').maxUploadBytes);
      expect(limit).not.toBe(entitlementsFor('free').maxUploadBytes);
    } finally {
      if (wasCloud === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = wasCloud;
    }
  });

  it('an automation condition MATCHES rather than silently never firing', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'AUT' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Matches the rule' },
      fx.ctx,
    );

    // Bound directly at the repository: the engine's own entry point needs a
    // rule row and an event envelope, and the read under test is the predicate.
    const matched = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.matchesAutomationCondition(
        item.id,
        {
          combinator: 'and',
          conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
        },
        undefined,
        tx,
      ),
    );
    expect(matched).toBe(true);
  });

  it('the AI boundary resolves each item’s latest revision id', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'AIB' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Has a revision' },
      fx.ctx,
    );

    const latest = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRevisionRepository.findLatestIdsByWorkItemIds([item.id], tx),
    );
    // The anchor every AI edit is validated against: unbound the map was empty
    // and every node came back with no `baseRevision` to write against.
    expect(latest.get(item.id)).toBeTruthy();
  });
});

// ── MOTIR-2810 · migrateOnboardingService ─────────────────────────────────────
//
// Both reads answer "has this already happened?", and code that asks that uses
// the answer to decide whether to SKIP a step. So an empty result does not read
// as an error — it reads as "no, not yet", and the flow does the work again. For
// an import or a plan generation, doing it again is duplicate content, not a
// harmless retry.
//
// ⚠️ THE JOB-PATH QUESTION, answered rather than assumed. `findBySourceJobId` is
// reached from a background job as well as a request, and the card asks whether
// that path has a workspace to bind at all. It does: every one of its eight call
// sites takes `ctx.workspaceId` from a `ServiceContext` the layer above already
// resolved — the job envelope carries the workspace, there is simply no acting
// USER. So the WORKSPACE tier is right everywhere and `withSystemContext` is
// wrong: `app.system_admin` is cross-tenant, and a plan lookup that could reach
// another tenant's plan is a worse outcome than one that reaches none.

describe('migrateOnboardingService — the "already done?" reads', () => {
  it('FINDS a completed import, so the flow skips rather than repeats it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'IMP' });
    await adminDb.import.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'jira',
        status: 'succeeded',
        createdById: fx.ownerId,
      },
    });

    const found = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      importRepository.findCompletedForProject(fx.projectId, fx.workspaceId, tx),
    );

    // The idempotence direction: unbound this was null, the step read as
    // "not yet done", and the import ran a second time.
    expect(found?.status).toBe('succeeded');
  });

  it('FINDS the plan a job produced, rather than reporting it produced nothing', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PLN' });
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        sourceJobId: 'job-abc-123',
      },
    });

    const plan = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.findBySourceJobId('job-abc-123', fx.workspaceId, tx),
    );

    // The single most damaging read in the story by measured blast radius:
    // unbound, the generation path looked up the plan it had just written and
    // concluded it had produced nothing.
    expect(plan?.status).toBe('planned');
  });
});

// ── MOTIR-2846 · the CALL SITES ───────────────────────────────────────────────
//
// Everything above tests a REPOSITORY that could not take a `tx`. These test the
// other half — reads that always could, whose callers never passed one. The
// symptom is not an empty chart: these are GATE reads, run before an action to
// answer "does this exist and may you touch it?". Unbound the answer is "it does
// not exist", so the product tells someone the item on their screen is gone.
//
// ⚠️ Each case names a SPECIFIC seeded row and asserts it comes BACK. Never
// `toHaveLength(n > 0)` on a list: the defect makes lists empty, so a
// non-emptiness assertion is exactly the shape that passes while the bug is
// fully intact. The card says this in as many words and it is worth repeating
// here, next to the tests it governs.

describe('backlogService — the 404 for an issue that is on the screen', () => {
  it('FINDS the seeded issue in the backlog page, and counts it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BKA' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'In the backlog' },
      fx.ctx,
    );

    const page = await backlogService.getBacklog(fx.projectId, {}, fx.ctx);

    // The id, not the length: an empty page is what the defect produces.
    expect(page.items.map((i) => i.id)).toContain(item.id);
    expect(page.totalCount).toBe(1);
  });

  it('ASSIGNS to a sprint — the read that 404`d a sprint that exists', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BKB' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint one' }, fx.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Dragged in' },
      fx.ctx,
    );

    // Unbound, `sprintRepository.findById` came back null and this threw
    // SprintNotFoundError — the drag failed for a sprint drawn on the board.
    const moved = await backlogService.assignToSprint(item.id, sprint.id, undefined, fx.ctx);
    expect(moved.sprintId).toBe(sprint.id);

    const inSprint = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(inSprint.items.map((i) => i.id)).toContain(item.id);
    expect(inSprint.totalCount).toBe(1);
  });
});

describe('workItemsService.updateStatus — the bare transaction that bound nothing', () => {
  it('TRANSITIONS the item and returns its new status', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'UPS' });
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Move me' },
      fx.ctx,
    );

    // `db.$transaction` opens a transaction and sets no GUC on it, so every gate
    // read inside `applyStatusTransition` — the item, its project, the workflow —
    // saw NULL context. The move 404'd an item the caller had just created.
    const moved = await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    expect(moved.id).toBe(item.id);
    expect(moved.status).toBe('in_progress');

    // Committed, not just returned.
    const readBack = await workItemsService.getWorkItem(item.id, fx.ctx);
    expect(readBack.status).toBe('in_progress');
  });
});

describe('workflowsService.getWorkflow — the project that had no workflow', () => {
  it('FINDS the seeded initial status and at least one transition', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'WFA' });

    const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);

    const initial = workflow.statuses.find((s) => s.isInitial);
    expect(initial?.key).toBe('todo');
    expect(workflow.statuses.map((s) => s.key)).toContain('in_progress');
    // The transitions half of the same read run — an empty set would make every
    // move illegal under the `restricted` policy rather than merely look odd.
    expect(
      workflow.transitions.some(
        (t) => t.fromStatusId === initial?.id && t.fromStatusId !== t.toStatusId,
      ),
    ).toBe(true);
  });
});

describe('the detail reads a call site had to bind', () => {
  it('sprintsService.listByProject FINDS the sprint and its issue count', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SLB' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Listed' }, fx.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Counted' },
      fx.ctx,
    );
    await backlogService.assignToSprint(item.id, sprint.id, undefined, fx.ctx);

    const sprints = await sprintsService.listByProject(fx.projectId, fx.ctx);

    const listed = sprints.find((s) => s.id === sprint.id);
    expect(listed?.name).toBe('Listed');
    // The per-sprint count rides the SAME transaction as the list; a zero here
    // would be the same silent-empty answer one level down.
    expect(listed?.issueCount).toBe(1);
  });

  it('plansService.getPlan FINDS the plan it just created', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PGP' });
    const created = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    const plan = await plansService.getPlan(created.id, fx.ctx);

    expect(plan.id).toBe(created.id);
    expect(plan.status).toBe('generating');
  });

  it('dashboardsService.getDashboard FINDS the dashboard the switcher listed', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'DSH' });
    const created = await dashboardsService.create({ name: 'My board' }, fx.ctx);

    const detail = await dashboardsService.getDashboard(created.id, fx.ctx);

    expect(detail.id).toBe(created.id);
    expect(detail.name).toBe('My board');
  });

  it('workItemsService.listRootIssues FINDS the root it just created', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RTL' });
    const root = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'A root' },
      fx.ctx,
    );

    const level = await workItemsService.listRootIssues(
      fx.projectId,
      { sort: { column: 'key', direction: 'asc' } },
      fx.ctx,
    );

    expect(level.rows.map((r) => r.id)).toContain(root.id);
    expect(level.total).toBe(1);
  });

  it('workItemsService.getDeletePreview COUNTS the descendant it would delete', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'DPV' });
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Child', parentId: parent.id },
      fx.ctx,
    );

    const preview = await workItemsService.getDeletePreview(parent.id, fx.ctx);

    // Unbound the subtree CTE returned nothing, so the confirm dialog promised
    // to delete one item and would have taken two.
    expect(preview.totalCount).toBe(2);
    expect(preview.liveDescendantCount).toBe(1);
    expect(child.id).toBeTruthy();
  });
});
