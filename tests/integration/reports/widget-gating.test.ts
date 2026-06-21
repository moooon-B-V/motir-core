import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md. Service-level
// tests pass `ctx` explicitly; the route transport tests drive
// `wsCtx.current` (the saved-filters suite convention).
import type { WorkspaceContext } from '@/lib/workspaces';
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import { GET as cvrGET } from '@/app/api/reports/created-vs-resolved/route';
import { GET as distributionGET } from '@/app/api/reports/distribution/route';
import { GET as filterResultsGET } from '@/app/api/reports/filter-results/route';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story 6.3 · Subtask 6.3.2 — the per-VIEWER gating matrix (route-level, the
// AC's home for it), the stale-referent matrix, the filter-results /items
// parity + page cap, and the route-level 422s/401. Real Postgres; routes
// drive the full transport → service → repository chain.

const BASE = 'http://localhost:3000';
const HIGH_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
};

interface Team {
  fx: WorkItemFixture;
  /** Workspace member NOT enrolled in the (private) project. */
  outsiderCtx: ServiceContext;
  /** Project member (role member). */
  memberCtx: ServiceContext;
  memberId: string;
}

/** Owner + an enrolled member + a workspace-only outsider, project PRIVATE.
 * NOTE the order: flipping to private AUTO-ENROLLS every CURRENT workspace
 * member (the visibility-preserving 6.4 rule), so the outsider joins the
 * workspace only AFTER the flip — a workspace member with no project
 * membership, the matrix's denied persona. */
async function makePrivateTeam(): Promise<Team> {
  const fx = await makeWorkItemFixture();
  const outsider = await createTestUser({ email: `outsider-${Date.now()}@example.com` });
  const member = await createTestUser({ email: `member-${Date.now()}@example.com` });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: member.id,
    role: 'member',
  });
  await projectMembersService.setAccessLevel({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    level: 'private',
  });
  await workspacesService.addMember({
    userId: outsider.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  return {
    fx,
    outsiderCtx: { userId: outsider.id, workspaceId: fx.workspaceId },
    memberCtx: { userId: member.id, workspaceId: fx.workspaceId },
    memberId: member.id,
  };
}

async function projectSharedFilter(fx: WorkItemFixture): Promise<string> {
  const filter = await savedFiltersService.create(
    fx.projectIdentifier,
    { name: 'High', visibility: 'project', filterParam: encodeFilterParam(HIGH_AST) },
    fx.ctx,
  );
  return filter.id;
}

async function getJson(
  handler: (req: Request) => Promise<Response>,
  query: string,
): Promise<{ status: number; body: { state?: string; reason?: string; code?: string } }> {
  const res = await handler(new Request(`${BASE}/api/reports/x?${query}`));
  return { status: res.status, body: (await res.json()) as never };
}

beforeEach(async () => {
  await truncateAuthTables();
  wsCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the per-viewer no-access matrix (route-level)', () => {
  it('private project × {owner, enrolled member, workspace outsider} × {project, filter} scope → data / data / no_access on ALL THREE reads', async () => {
    const t = await makePrivateTeam();
    const filterId = await projectSharedFilter(t.fx);
    await createTestWorkItem(t.fx, { kind: 'task', title: 'seed' });

    const scopes = [`projectId=${t.fx.projectId}`, `savedFilterId=${filterId}`];
    const reads: Array<[typeof cvrGET, string]> = [
      [cvrGET, 'period=day&daysBack=7'],
      [distributionGET, 'statistic=kind'],
      [filterResultsGET, 'page=1'],
    ];

    for (const scope of scopes) {
      for (const [handler, extra] of reads) {
        // The viewer is the REQUESTING user, never the owner of anything:
        wsCtx.current = t.fx.ctx; // owner — sees data
        expect((await getJson(handler, `${scope}&${extra}`)).body.state).toBe('ok');
        wsCtx.current = t.memberCtx; // enrolled member — sees data
        expect((await getJson(handler, `${scope}&${extra}`)).body.state).toBe('ok');
        wsCtx.current = t.outsiderCtx; // workspace member, NOT on the project
        const denied = await getJson(handler, `${scope}&${extra}`);
        expect(denied.status).toBe(200); // a widget state, not a transport error
        expect(denied.body).toEqual({ state: 'no_access' });
      }
    }
  });

  it('a missing project is indistinguishable from a forbidden one (finding #44)', async () => {
    const t = await makePrivateTeam();
    wsCtx.current = t.outsiderCtx;
    const missing = await getJson(distributionGET, 'projectId=nope12345&statistic=kind');
    const forbidden = await getJson(distributionGET, `projectId=${t.fx.projectId}&statistic=kind`);
    expect(missing.body).toEqual(forbidden.body);
    expect(missing.body).toEqual({ state: 'no_access' });
  });

  it('a cross-workspace scope reads as nonexistent (no tenant leak)', async () => {
    const t = await makePrivateTeam();
    const stranger = await makeWorkItemFixture({ name: 'Strangers', identifier: 'STRX' });
    const strangerFilter = await projectSharedFilter(stranger);

    wsCtx.current = t.fx.ctx; // the OWNER of workspace A probing workspace B's ids
    expect(
      (await getJson(distributionGET, `projectId=${stranger.projectId}&statistic=kind`)).body,
    ).toEqual({ state: 'no_access' });
    expect(
      (await getJson(distributionGET, `savedFilterId=${strangerFilter}&statistic=kind`)).body,
    ).toEqual({ state: 'stale', reason: 'filter_missing' });
  });

  it("another user's PRIVATE filter is invisible → the stale filter_missing card (finding #44)", async () => {
    const t = await makePrivateTeam();
    const secret = await savedFiltersService.create(
      t.fx.projectIdentifier,
      { name: 'Secret', visibility: 'private', filterParam: encodeFilterParam(HIGH_AST) },
      t.fx.ctx,
    );
    wsCtx.current = t.memberCtx; // CAN browse the project; cannot SEE the filter
    expect((await getJson(filterResultsGET, `savedFilterId=${secret.id}`)).body).toEqual({
      state: 'stale',
      reason: 'filter_missing',
    });
  });
});

describe('the stale-referent matrix', () => {
  it('a deleted filter → filter_missing; a corrupted stored envelope → filter_invalid', async () => {
    const fx = await makeWorkItemFixture();
    const filterId = await projectSharedFilter(fx);
    wsCtx.current = fx.ctx;

    // Corrupt the envelope in place (a future-versioned payload).
    await db.savedFilter.update({
      where: { id: filterId },
      data: { astEnvelope: { v: 'v999', ast: {} } },
    });
    expect((await getJson(filterResultsGET, `savedFilterId=${filterId}`)).body).toEqual({
      state: 'stale',
      reason: 'filter_invalid',
    });

    await db.savedFilter.delete({ where: { id: filterId } });
    expect((await getJson(filterResultsGET, `savedFilterId=${filterId}`)).body).toEqual({
      state: 'stale',
      reason: 'filter_missing',
    });
  });

  it('a deleted statistic referent → statistic_missing (route-level)', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    expect(
      (await getJson(distributionGET, `projectId=${fx.projectId}&statistic=cf:goneXXXX`)).body,
    ).toEqual({ state: 'stale', reason: 'statistic_missing' });
  });
});

describe('filter-results — /items parity + the 50/page cap', () => {
  it('a widget page exactly matches getProjectIssuesList for the same filter (rows, total, order)', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 8; i++) {
      const item = await createTestWorkItem(fx, { kind: 'task', title: `T${i}` });
      await db.workItem.update({
        where: { id: item.id },
        data: { priority: i % 2 === 0 ? 'high' : 'low' },
      });
    }
    const filterId = await projectSharedFilter(fx); // priority = high → 4 items

    const widget = await reportsService.getFilterResultsPage(
      { savedFilterId: filterId },
      { page: 1, pageSize: 3 },
      fx.ctx,
    );
    expect(widget.state).toBe('ok');
    if (widget.state !== 'ok') throw new Error('unreachable');

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, filter: { ast: HIGH_AST }, page: 1, pageSize: 3 },
      fx.ctx,
    );
    expect(widget.data.total).toBe(4);
    expect(widget.data).toEqual(list); // byte-equal: same read, no second query path

    // Page 2 parity too (the pager walks the same offsets).
    const widgetP2 = await reportsService.getFilterResultsPage(
      { savedFilterId: filterId },
      { page: 2, pageSize: 3 },
      fx.ctx,
    );
    if (widgetP2.state !== 'ok') throw new Error('unreachable');
    expect(widgetP2.data.items).toHaveLength(1);
    expect(widgetP2.data.items[0]!.id).not.toBe(widget.data.items[0]!.id);
  });

  it('pageSize clamps to the verified 50/page gadget cap server-side', async () => {
    const fx = await makeWorkItemFixture();
    await createTestWorkItem(fx, { kind: 'task', title: 'one' });
    const result = await reportsService.getFilterResultsPage(
      { projectId: fx.projectId },
      { page: 1, pageSize: 500 },
      fx.ctx,
    );
    if (result.state !== 'ok') throw new Error('unreachable');
    expect(result.data.pageSize).toBe(ISSUE_LIST_PAGE_SIZE); // 50 — never the requested 500
  });

  it('a project scope pages the whole project (no AST)', async () => {
    const fx = await makeWorkItemFixture();
    await createTestWorkItem(fx, { kind: 'task', title: 'a' });
    await createTestWorkItem(fx, { kind: 'bug', title: 'b' });
    const result = await reportsService.getFilterResultsPage(
      { projectId: fx.projectId },
      {},
      fx.ctx,
    );
    if (result.state !== 'ok') throw new Error('unreachable');
    expect(result.data.total).toBe(2);
  });
});

describe('route-level config 422s + 401', () => {
  it('unauthenticated → 401 on all three routes', async () => {
    wsCtx.current = null;
    for (const handler of [cvrGET, distributionGET, filterResultsGET]) {
      expect((await getJson(handler, 'projectId=p1')).status).toBe(401);
    }
  });

  it('scope XOR, window caps, unknown period/statistic → typed 422s', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const cases: Array<[typeof cvrGET, string, string]> = [
      [cvrGET, `projectId=${fx.projectId}&savedFilterId=f1`, 'INVALID_REPORT_SCOPE'],
      [cvrGET, `period=day&daysBack=7`, 'INVALID_REPORT_SCOPE'],
      [cvrGET, `projectId=${fx.projectId}&period=quarter`, 'INVALID_REPORT_WINDOW'],
      [cvrGET, `projectId=${fx.projectId}&daysBack=soon`, 'INVALID_REPORT_WINDOW'],
      [cvrGET, `projectId=${fx.projectId}&period=day&daysBack=121`, 'INVALID_REPORT_WINDOW'],
      [cvrGET, `projectId=${fx.projectId}&period=week&daysBack=367`, 'INVALID_REPORT_WINDOW'],
      [distributionGET, `projectId=${fx.projectId}`, 'INVALID_REPORT_SCOPE'], // statistic required
      [distributionGET, `projectId=${fx.projectId}&statistic=bogus`, 'UNKNOWN_STATISTIC_TYPE'],
      [filterResultsGET, ``, 'INVALID_REPORT_SCOPE'],
    ];
    for (const [handler, query, code] of cases) {
      const res = await getJson(handler, query);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    }
  });
});
