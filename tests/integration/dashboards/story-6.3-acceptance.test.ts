import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md.
import type { WorkspaceContext } from '@/lib/workspaces';
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReportScopeDto } from '@/lib/dto/reports';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story 6.3 · Subtask 6.3.7 — the STORY-CLOSING acceptance test (Principle
// #18: review at the Story level). This is the SERVICE-TIER analog of the
// dashboards/reports E2E journeys: it drives the Story 6.3 verification recipe
// end-to-end as ONE narrative, across BOTH the 6.3.1 `dashboardsService` and
// the 6.3.2 `reportsService` — create a workspace dashboard, add all three
// widget types (filter- AND project-sourced), read each widget, share it,
// hit the per-VIEWER 6.4 gate, then delete the backing filter and confirm the
// widget goes STALE while the dashboard SURVIVES.
//
// It deliberately does NOT re-assert the exhaustive matrices the per-subtask
// integration suites already own — the bucket / cumulative / window-edge
// matrix (tests/integration/reports/created-vs-resolved.test.ts), the
// registry-driven statistic matrix (…/distribution.test.ts), the per-viewer ×
// scope × stale route matrix + filter-results parity (…/widget-gating.test.ts),
// and the CRUD / move-ordering / registry-totality matrix
// (…/dashboards/dashboards.test.ts). What it adds is the CROSS-SERVICE WIRING
// those piece-tests can't see: that a dashboard's widgets, once created through
// `dashboardsService`, resolve through `reportsService` as the SAME data the
// reports read, agree on the done-predicate, and degrade together.

const HIGH_PRIORITY_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

let seq = 0;

interface Recipe {
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  projectId: string;
  projectIdentifier: string;
  filterId: string;
}

/** Owner workspace + project + one plain workspace member + one project saved
 * filter — the recipe's "Team overview" tenant. Seed a handful of work items
 * created in-window, a subset resolved (a `todo → done` revision in-window),
 * so the widget reads return real, non-empty aggregates. */
async function seedRecipe(): Promise<Recipe> {
  seq += 1;
  const fx = await makeWorkItemFixture({ identifier: `A${String(seq).padStart(3, '0')}` });
  const member = await createTestUser({
    email: `acc-member-${seq}@example.com`,
    name: 'Morgan Member',
  });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  const filter = await savedFiltersService.create(
    fx.projectIdentifier,
    {
      name: 'High priority',
      visibility: 'project',
      filterParam: encodeFilterParam(HIGH_PRIORITY_AST),
    },
    fx.ctx,
  );

  // 5 items created two days ago; 2 of them resolved (todo → done) one day ago.
  for (let i = 0; i < 5; i++) {
    const item = await createTestWorkItem(fx, { kind: 'task', title: `Recipe item ${i}` });
    await db.workItem.update({ where: { id: item.id }, data: { createdAt: daysAgo(2) } });
    if (i < 2) {
      await db.workItemRevision.create({
        data: {
          workItemId: item.id,
          changedById: fx.ownerId,
          changeKind: 'updated',
          changedAt: daysAgo(1),
          diff: { status: { from: 'todo', to: 'done' } } as Prisma.InputJsonValue,
        },
      });
    }
  }

  return {
    ownerCtx: fx.ctx,
    memberCtx: { userId: member.id, workspaceId: fx.workspaceId },
    projectId: fx.projectId,
    projectIdentifier: fx.projectIdentifier,
    filterId: filter.id,
  };
}

const CVR_CONFIG = { period: 'day', daysBack: 30, cumulative: false } as const;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('Story 6.3 recipe — dashboard + three widgets, shared, read end-to-end', () => {
  it('creates a workspace dashboard and adds all three widget types (filter- and project-sourced)', async () => {
    const r = await seedRecipe();
    const dash = await dashboardsService.create(
      { name: 'Team overview', access: 'workspace' },
      r.ownerCtx,
    );

    const filterResults = await dashboardsService.addWidget(
      dash.id,
      { type: 'filter_results', savedFilterId: r.filterId, config: { pageSize: 25 } },
      r.ownerCtx,
    );
    const distribution = await dashboardsService.addWidget(
      dash.id,
      { type: 'distribution', projectId: r.projectId, config: { statisticType: 'status' } },
      r.ownerCtx,
    );
    const createdVsResolved = await dashboardsService.addWidget(
      dash.id,
      { type: 'created_vs_resolved', projectId: r.projectId, config: CVR_CONFIG },
      r.ownerCtx,
    );

    const detail = await dashboardsService.getDashboard(dash.id, r.ownerCtx);
    expect(detail.widgets.map((w) => w.id).sort()).toEqual(
      [filterResults.id, distribution.id, createdVsResolved.id].sort(),
    );
    // Mixed data sources survive the round-trip (the XOR the registry enforces).
    expect(filterResults.source).toMatchObject({ kind: 'saved_filter', savedFilterId: r.filterId });
    expect(distribution.source).toMatchObject({ kind: 'project', projectId: r.projectId });
  });

  it("the three widget reads return the seeded reality, and CvR's resolved series agrees with the done-predicate", async () => {
    const r = await seedRecipe();
    const filterScope: ReportScopeDto = { savedFilterId: r.filterId };
    const projectScope: ReportScopeDto = { projectId: r.projectId };

    const cvr = await reportsService.getCreatedVsResolved(projectScope, CVR_CONFIG, r.ownerCtx);
    expect(cvr.state).toBe('ok');
    if (cvr.state !== 'ok') throw new Error('unreachable');
    // 5 created in-window, exactly 2 net `todo → done` transitions in-window —
    // the SAME done-category predicate the burndown / velocity / rollups use.
    const createdTotal = cvr.data.buckets.reduce((s, b) => s + b.created, 0);
    const resolvedTotal = cvr.data.buckets.reduce((s, b) => s + b.resolved, 0);
    expect(createdTotal).toBe(5);
    expect(resolvedTotal).toBe(2);

    const dist = await reportsService.getDistribution(projectScope, 'status', r.ownerCtx);
    expect(dist.state).toBe('ok');
    if (dist.state !== 'ok') throw new Error('unreachable');
    // The donut is bounded + total over the project's items; percentages close.
    expect(dist.data.total).toBe(5);
    const pctSum = dist.data.segments.reduce((s, seg) => s + seg.percentage, 0);
    expect(Math.round(pctSum)).toBe(100);

    const page = await reportsService.getFilterResultsPage(
      filterScope,
      { pageSize: 25 },
      r.ownerCtx,
    );
    expect(page.state).toBe('ok');
    if (page.state !== 'ok') throw new Error('unreachable');
    // Filter-results is the EXISTING /items list read for the same filter
    // (the verified ≤50/page gadget cap holds — 25 here, never exceeded).
    expect(page.data.pageSize).toBeLessThanOrEqual(50);
  });

  it('a workspace-shared dashboard is visible + read-only to a member, and editing is owner-only', async () => {
    const r = await seedRecipe();
    const dash = await dashboardsService.create(
      { name: 'Team overview', access: 'workspace' },
      r.ownerCtx,
    );
    await dashboardsService.addWidget(
      dash.id,
      { type: 'distribution', projectId: r.projectId, config: { statisticType: 'priority' } },
      r.ownerCtx,
    );

    // The member sees the shared dashboard in their list + can open it…
    const memberList = await dashboardsService.listDashboards(r.memberCtx);
    expect(memberList.map((d) => d.id)).toContain(dash.id);
    const memberView = await dashboardsService.getDashboard(dash.id, r.memberCtx);
    expect(memberView.isOwner).toBe(false);

    // …but cannot mutate it (owner-only edit — the recipe's sharing rule).
    await expect(
      dashboardsService.update(dash.id, { name: 'hijacked' }, r.memberCtx),
    ).rejects.toThrow();
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', savedFilterId: r.filterId },
        r.memberCtx,
      ),
    ).rejects.toThrow();
  });

  it('per-VIEWER 6.4 gate: a widget over a now-private project leaks nothing to a non-member, while the owner still reads it', async () => {
    const r = await seedRecipe();
    const projectScope: ReportScopeDto = { projectId: r.projectId };

    // Flip the project private FIRST — this auto-enrolls the CURRENT members
    // (finding #44). THEN add a fresh workspace member: joining after the flip,
    // they are never enrolled on the project — a true per-viewer outsider (the
    // widget-gating ordering).
    await projectMembersService.setAccessLevel({
      key: r.projectIdentifier,
      actorUserId: r.ownerCtx.userId,
      ctx: r.ownerCtx,
      level: 'private',
    });
    const outsider = await createTestUser({
      email: `acc-outsider-${seq}@example.com`,
      name: 'Otto Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: r.ownerCtx.workspaceId,
      role: 'member',
    });
    const outsiderCtx: ServiceContext = {
      userId: outsider.id,
      workspaceId: r.ownerCtx.workspaceId,
    };

    // Owner still reads real data…
    const ownerRead = await reportsService.getDistribution(projectScope, 'status', r.ownerCtx);
    expect(ownerRead.state).toBe('ok');

    // …the outsider gets the no-access widget state on EVERY read — never a
    // count, a row, or a chart shape (the mirror gadget behaviour).
    const dist = await reportsService.getDistribution(projectScope, 'status', outsiderCtx);
    expect(dist).toEqual({ state: 'no_access' });
    const cvr = await reportsService.getCreatedVsResolved(projectScope, CVR_CONFIG, outsiderCtx);
    expect(cvr).toEqual({ state: 'no_access' });
    const page = await reportsService.getFilterResultsPage(projectScope, {}, outsiderCtx);
    expect(page).toEqual({ state: 'no_access' });
  });

  it('deleting the backing saved filter STALES its widget read while the dashboard survives', async () => {
    const r = await seedRecipe();
    const dash = await dashboardsService.create(
      { name: 'Team overview', access: 'workspace' },
      r.ownerCtx,
    );
    const widget = await dashboardsService.addWidget(
      dash.id,
      { type: 'filter_results', savedFilterId: r.filterId, config: { pageSize: 10 } },
      r.ownerCtx,
    );

    await savedFiltersService.delete(r.projectIdentifier, r.filterId, r.ownerCtx);

    // The dashboard + widget row SURVIVE (the FK is SetNull, not Cascade — the
    // widget stales, it never disappears) …
    const detail = await dashboardsService.getDashboard(dash.id, r.ownerCtx);
    const stillThere = detail.widgets.find((w) => w.id === widget.id);
    expect(stillThere).toBeDefined();
    expect(stillThere!.source.kind).toBe('stale');

    // … and the widget READ degrades to the typed stale state, never a crash.
    const read = await reportsService.getFilterResultsPage(
      { savedFilterId: r.filterId },
      {},
      r.ownerCtx,
    );
    expect(read).toEqual({ state: 'stale', reason: 'filter_missing' });
  });
});
