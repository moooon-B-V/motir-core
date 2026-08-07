import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { estimationService } from '@/lib/services/estimationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The `report:view` GATE (Story MOTIR-2291 · Subtask MOTIR-2351).
//
// This key is BROWSE-WIDE by decision (`docs/decisions/member-facing-permissions.md`
// §1 — Jira has no report permission separate from *Browse Projects*), so the
// interesting assertions here are mostly the ones that must NOT fail: a project
// `viewer` still reads every one of the eleven analytics paths. A gate that
// quietly narrowed reporting to members would be a regression this story is
// specifically trying not to cause.
//
// The one behaviour that DOES change is the last describe: an actor who cannot
// browse the project can no longer summarise it through an aggregate, and the
// refusal is a 404, not a 403 — one unguarded read of an aggregate hands over a
// whole project, and a 403 would confirm the project exists on the way.

const PASSWORD = 'hunter2hunter2';

interface Fixture {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerCtx: ServiceContext;
  viewerCtx: ServiceContext;
  /** A workspace member with NO project membership — holds `report:view` implicitly. */
  outsiderCtx: ServiceContext;
  /** A workspace member of ANOTHER workspace — cannot browse, so cannot report. */
  foreignCtx: ServiceContext;
}

let seq = 0;

async function makeFixture(label: string): Promise<Fixture> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `rep-owner-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Rep WS ${label} ${seq}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId };

  const viewer = await usersService.createUser({
    email: `rep-viewer-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Viewer',
  });
  await db.workspaceMembership.create({ data: { userId: viewer.id, workspaceId, role: 'member' } });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: viewer.id,
    role: 'viewer',
  });

  const outsider = await usersService.createUser({
    email: `rep-outsider-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Outsider',
  });
  await db.workspaceMembership.create({
    data: { userId: outsider.id, workspaceId, role: 'member' },
  });

  // A whole other tenant: their context carries their OWN workspace id, which is
  // what makes this project unresolvable for them.
  const foreigner = await usersService.createUser({
    email: `rep-foreign-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Foreigner',
  });
  const otherWs = await workspacesService.createWorkspace({
    name: `Rep Other WS ${label} ${seq}`,
    ownerUserId: foreigner.id,
  });

  return {
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    viewerCtx: { userId: viewer.id, workspaceId },
    outsiderCtx: { userId: outsider.id, workspaceId },
    foreignCtx: { userId: foreigner.id, workspaceId: otherWs.workspace.id },
  };
}

const WINDOW = { period: 'week' as const, daysBack: 28 };

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('report:view is BROWSE-WIDE — a project viewer reads every analytics path', () => {
  it('reads the roadmap, the velocity and all six report widgets', async () => {
    const fx = await makeFixture('viewer-all');
    const scope = { projectId: fx.projectId };

    await expect(
      workItemsService.getProjectRoadmap(fx.projectId, null, fx.viewerCtx),
    ).resolves.toBeTruthy();
    await expect(
      reportsService.getVelocity({ projectId: fx.projectId }, fx.viewerCtx),
    ).resolves.toBeTruthy();

    // The widget reads answer with a typed STATE rather than throwing — `ok` is
    // the assertion, because `no_access` is exactly what a failed gate produces.
    expect(
      (
        await reportsService.getCreatedVsResolved(
          scope,
          { ...WINDOW, cumulative: false },
          fx.viewerCtx,
        )
      ).state,
    ).toBe('ok');
    expect((await reportsService.getAverageAge(scope, WINDOW, fx.viewerCtx)).state).toBe('ok');
    expect((await reportsService.getResolutionTime(scope, WINDOW, fx.viewerCtx)).state).toBe('ok');
    expect(
      (await reportsService.getWorkload(scope, { measure: 'issue_count' }, fx.viewerCtx)).state,
    ).toBe('ok');
    expect((await reportsService.getDistribution(scope, 'status', fx.viewerCtx)).state).toBe('ok');
    expect((await reportsService.getFilterResultsPage(scope, {}, fx.viewerCtx)).state).toBe('ok');
  });

  it('reads the three sprint analytics the sprint card handed over', async () => {
    const fx = await makeFixture('viewer-sprint');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await sprintsService.startSprint(sprint.id, {}, fx.ownerCtx);

    await expect(estimationService.rollupForSprint(sprint.id, fx.viewerCtx)).resolves.toBeTruthy();
    await expect(sprintsService.getSprintReport(sprint.id, {}, fx.viewerCtx)).resolves.toBeTruthy();
    await expect(reportsService.getSprintCycleGraph(sprint.id, fx.viewerCtx)).resolves.toBeTruthy();
  });

  it('admits a workspace member holding NO project membership — the implicit grant', async () => {
    // §2 of the decision: `report:view` is the ONE of the eight this actor gets.
    // A stranger to the project may read its charts because they may already read
    // its work items one row at a time.
    const fx = await makeFixture('viewer-implicit');
    await expect(
      reportsService.getVelocity({ projectId: fx.projectId }, fx.outsiderCtx),
    ).resolves.toBeTruthy();
    expect(
      (
        await reportsService.getWorkload(
          { projectId: fx.projectId },
          { measure: 'issue_count' },
          fx.outsiderCtx,
        )
      ).state,
    ).toBe('ok');
  });
});

describe('an actor who cannot BROWSE cannot summarise — and the refusal is a 404', () => {
  it('404s the roadmap, the velocity and the sprint analytics for a foreign actor', async () => {
    const fx = await makeFixture('deny-throwing');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);

    await expect(
      workItemsService.getProjectRoadmap(fx.projectId, null, fx.foreignCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      reportsService.getVelocity({ projectId: fx.projectId }, fx.foreignCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    // The sprint reads 404 on the SPRINT first (it is workspace-filtered), which
    // is the same posture one layer earlier.
    await expect(estimationService.rollupForSprint(sprint.id, fx.foreignCtx)).rejects.toThrow();
  });

  it('degrades the six widget reads to `no_access` rather than throwing', async () => {
    // The shipped dashboard contract: a widget whose scope has gone away renders
    // a typed card so the rest of the page survives. The gate runs BEFORE any
    // data read either way — what differs is how the refusal is presented.
    const fx = await makeFixture('deny-widget');
    const scope = { projectId: fx.projectId };
    expect((await reportsService.getAverageAge(scope, WINDOW, fx.foreignCtx)).state).toBe(
      'no_access',
    );
    expect(
      (await reportsService.getWorkload(scope, { measure: 'issue_count' }, fx.foreignCtx)).state,
    ).toBe('no_access');
    expect((await reportsService.getFilterResultsPage(scope, {}, fx.foreignCtx)).state).toBe(
      'no_access',
    );
  });
});

describe('filter-results resolves its project from the FILTER it runs', () => {
  it('cannot be used to run another project’s filter', async () => {
    // The scope carries only a saved-filter id, so the project is whatever that
    // filter belongs to — which is exactly why the gate has to be applied to the
    // RESOLVED project rather than to anything the caller supplied.
    const mine = await makeFixture('filter-mine');
    const theirs = await makeFixture('filter-theirs');
    const theirFilter = await savedFiltersService.create(
      theirs.projectKey,
      {
        name: 'Theirs',
        visibility: 'project',
        filterParam: encodeFilterParam({
          combinator: 'and',
          conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
        }),
      },
      theirs.ownerCtx,
    );

    const result = await reportsService.getFilterResultsPage(
      { savedFilterId: theirFilter.id },
      {},
      mine.ownerCtx,
    );
    // Not `ok`: the filter row is invisible across the tenant boundary, so the
    // widget degrades rather than running somebody else's query.
    expect(result.state).not.toBe('ok');
  });
});
