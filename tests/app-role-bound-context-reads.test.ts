import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { boardsService } from '@/lib/services/boardsService';
import { estimationService } from '@/lib/services/estimationService';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
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

describe('the `tx ?? db` fallback arm of the saved-filter reads', () => {
  // ⚠️ DELIBERATELY UNBOUND, and both arms are asserted. The optional `tx` is what
  // `tests/rls/singletonReadScan.ts` recognises as BINDABLE, so it has to stay —
  // but once every production call site threads a `tx`, the `db` arm has no
  // caller left and would go uncovered against the file's ≥90% branch floor.
  //
  // The assertion is split by role rather than weakened, because the two answers
  // are BOTH the contract: on the bypass role the fallback reads normally; on
  // `motir_app` it binds nothing, the policy sees NULL, and the honest answer is
  // the EMPTY one. Asserting rows here would be asserting that a path with no
  // binding at all somehow works — the vacuous-pass shape this story exists to
  // remove.
  it('resolves to the singleton, and returns the empty answer under the app role', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFE' });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'Fallback', visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
      fx.ctx,
    );
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'daily', hour: 9 },
      fx.ctx,
    );

    const listArgs = {
      projectId: fx.projectId,
      actorUserId: fx.ownerId,
      actorIsAdmin: true,
      view: 'all' as const,
    };
    const rows = await savedFilterRepository.listPage({ ...listArgs, take: 10 });
    const total = await savedFilterRepository.countVisible(listArgs);
    const subs = await savedFilterSubscriptionRepository.countByFilter(filter.id);

    if (isAppRoleTestMode()) {
      expect(rows).toEqual([]);
      expect(total).toBe(0);
      expect(subs).toBe(0);
    } else {
      expect(rows.map((r) => r.name)).toEqual(['Fallback']);
      expect(total).toBe(1);
      expect(subs).toBe(1);
    }
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

    const unbound = await workItemRepository.findByIds([blocker.id]);
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
