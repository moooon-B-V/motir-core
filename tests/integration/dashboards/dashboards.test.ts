import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md. Service-level
// tests pass `ctx` explicitly; the route transport tests drive
// `wsCtx.current` (the saved-filters test pattern).
import type { WorkspaceContext } from '@/lib/workspaces';
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import { DashboardWidgetType } from '@prisma/client';
import { db } from '@/lib/db';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { dashboardRepository } from '@/lib/repositories/dashboardRepository';
import { dashboardWidgetRepository } from '@/lib/repositories/dashboardWidgetRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  WIDGET_REGISTRY,
  WIDGET_TYPES,
  classifyStoredSource,
  widgetDefinition,
} from '@/lib/dashboards/widgetRegistry';
import {
  DASHBOARD_MAX_WIDGETS,
  DASHBOARD_NAME_MAX_LENGTH,
  LAYOUT_COLUMN_COUNT,
} from '@/lib/dashboards/constants';
import {
  DashboardForbiddenError,
  DashboardNotFoundError,
  DashboardWidgetCapError,
  DashboardWidgetNotFoundError,
  DashboardWidgetSourceNotFoundError,
  InvalidDashboardAccessError,
  InvalidDashboardLayoutError,
  InvalidDashboardNameError,
  InvalidDashboardWidgetConfigError,
  InvalidDashboardWidgetMoveError,
  UnknownDashboardWidgetTypeError,
} from '@/lib/dashboards/errors';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { GET as listGET, POST as createPOST } from '@/app/api/dashboards/route';
import {
  DELETE as dashboardDELETE,
  GET as detailGET,
  PATCH as dashboardPATCH,
} from '@/app/api/dashboards/[dashboardId]/route';
import { POST as widgetPOST } from '@/app/api/dashboards/[dashboardId]/widgets/route';
import {
  DELETE as widgetDELETE,
  PATCH as widgetPATCH,
} from '@/app/api/dashboards/[dashboardId]/widgets/[widgetId]/route';
import { POST as movePOST } from '@/app/api/dashboards/[dashboardId]/widgets/[widgetId]/move/route';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story 6.3 · Subtask 6.3.1 — the dashboard + widget substrate. Real
// Postgres (no mocks except getWorkspaceContext for the route transport),
// per CLAUDE.md. Asserts: the TOTAL widget-type registry (enumeration +
// config matrices + the data-source XOR — mistake #29); the permission rule
// (member create / owner-only mutate / private invisible) at the service
// AND route layer; the 20-widget cap; server-minted fractional move
// ordering (the 3.2 pattern); the FK split (SetNull stales a filter-sourced
// widget, Cascade takes a project-sourced one); the 6.2.1 delete-dependents
// widget count; bounded reads; and the repo empty-input guards.

const SIMPLE_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
};

interface Team {
  fx: WorkItemFixture;
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  memberId: string;
  /** A saved filter in the fixture project (filter-sourced widgets). */
  filterId: string;
}

let seq = 0;

/** Workspace owner + one plain member + one saved filter. */
async function makeTeam(): Promise<Team> {
  seq += 1;
  const fx = await makeWorkItemFixture({ identifier: `D${String(seq).padStart(3, '0')}` });
  const member = await createTestUser({ email: `dash-member-${seq}@example.com`, name: 'member' });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  const filter = await savedFiltersService.create(
    fx.projectIdentifier,
    { name: 'High priority', visibility: 'project', filterParam: encodeFilterParam(SIMPLE_AST) },
    fx.ctx,
  );
  return {
    fx,
    ownerCtx: fx.ctx,
    memberCtx: { userId: member.id, workspaceId: fx.workspaceId },
    memberId: member.id,
    filterId: filter.id,
  };
}

function filterWidgetInput(t: Team, type = 'filter_results') {
  return type === 'distribution'
    ? { type, savedFilterId: t.filterId, config: { statisticType: 'status' } }
    : { type, savedFilterId: t.filterId };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the widget registry is TOTAL (mistake #29)', () => {
  it('every dashboard_widget_type enum value has a full registry entry', () => {
    expect(WIDGET_TYPES.sort()).toEqual(Object.values(DashboardWidgetType).sort());
    for (const type of Object.values(DashboardWidgetType)) {
      const def = WIDGET_REGISTRY[type];
      expect(def, `registry gap for "${type}"`).toBeDefined();
      expect(def.type).toBe(type);
      expect(typeof def.parseConfig).toBe('function');
      expect(typeof def.resolveDataSource).toBe('function');
      expect(def.rendererKind.length).toBeGreaterThan(0);
      expect(def.editorKind.length).toBeGreaterThan(0);
    }
  });

  it('an unknown type is a typed rejection, never a silent pass-through', () => {
    expect(() => widgetDefinition('burndown')).toThrow(UnknownDashboardWidgetTypeError);
    expect(() => widgetDefinition('')).toThrow(UnknownDashboardWidgetTypeError);
  });

  it('the data-source XOR holds for every type', () => {
    for (const type of Object.values(DashboardWidgetType)) {
      const def = WIDGET_REGISTRY[type];
      expect(() => def.resolveDataSource({})).toThrow(InvalidDashboardWidgetConfigError);
      expect(() => def.resolveDataSource({ savedFilterId: 'f', projectId: 'p' })).toThrow(
        InvalidDashboardWidgetConfigError,
      );
      expect(() => def.resolveDataSource({ savedFilterId: '  ' })).toThrow(
        InvalidDashboardWidgetConfigError,
      );
      expect(def.resolveDataSource({ savedFilterId: 'f' })).toEqual({
        kind: 'saved_filter',
        savedFilterId: 'f',
      });
      expect(def.resolveDataSource({ projectId: 'p' })).toEqual({
        kind: 'project',
        projectId: 'p',
      });
    }
  });

  it('filter_results config: pageSize defaults to the cap and rejects out-of-range values', () => {
    const def = WIDGET_REGISTRY.filter_results;
    expect(def.parseConfig(undefined)).toEqual({ pageSize: 50 });
    expect(def.parseConfig({})).toEqual({ pageSize: 50 });
    expect(def.parseConfig({ pageSize: 10 })).toEqual({ pageSize: 10 });
    for (const bad of [0, 51, 1.5, '10', null, true]) {
      expect(() => def.parseConfig({ pageSize: bad })).toThrow(InvalidDashboardWidgetConfigError);
    }
    expect(() => def.parseConfig({ pageSize: 10, rows: 5 })).toThrow(
      InvalidDashboardWidgetConfigError,
    );
    expect(() => def.parseConfig([])).toThrow(InvalidDashboardWidgetConfigError);
    expect(() => def.parseConfig('x')).toThrow(InvalidDashboardWidgetConfigError);
  });

  it('distribution config: statisticType is required, trimmed, and capped', () => {
    const def = WIDGET_REGISTRY.distribution;
    expect(def.parseConfig({ statisticType: ' status ' })).toEqual({ statisticType: 'status' });
    for (const bad of [undefined, '', '  ', 42, 'x'.repeat(101)]) {
      expect(() => def.parseConfig({ statisticType: bad })).toThrow(
        InvalidDashboardWidgetConfigError,
      );
    }
    expect(() => def.parseConfig({ statisticType: 'status', extra: 1 })).toThrow(
      InvalidDashboardWidgetConfigError,
    );
  });

  it('created_vs_resolved config: defaults, enums, window + bucket caps', () => {
    const def = WIDGET_REGISTRY.created_vs_resolved;
    expect(def.parseConfig(undefined)).toEqual({ period: 'day', daysBack: 30, cumulative: false });
    expect(def.parseConfig({ period: 'week', daysBack: 90, cumulative: true })).toEqual({
      period: 'week',
      daysBack: 90,
      cumulative: true,
    });
    expect(() => def.parseConfig({ period: 'year' })).toThrow(InvalidDashboardWidgetConfigError);
    for (const bad of [0, 367, 1.5, '30']) {
      expect(() => def.parseConfig({ daysBack: bad })).toThrow(InvalidDashboardWidgetConfigError);
    }
    // 200 day-buckets blows the 120-bucket cap; the same window week-bucketed fits.
    expect(() => def.parseConfig({ period: 'day', daysBack: 200 })).toThrow(
      InvalidDashboardWidgetConfigError,
    );
    expect(def.parseConfig({ period: 'week', daysBack: 200 })).toMatchObject({ daysBack: 200 });
    expect(() => def.parseConfig({ cumulative: 'yes' })).toThrow(InvalidDashboardWidgetConfigError);
  });

  it('classifyStoredSource: both-null can only mean a SetNull-staled filter widget', () => {
    expect(classifyStoredSource({ savedFilterId: 'f', projectId: null })).toEqual({
      kind: 'saved_filter',
      savedFilterId: 'f',
    });
    expect(classifyStoredSource({ savedFilterId: null, projectId: 'p' })).toEqual({
      kind: 'project',
      projectId: 'p',
    });
    expect(classifyStoredSource({ savedFilterId: null, projectId: null })).toEqual({
      kind: 'stale',
    });
  });
});

describe('dashboard CRUD — validation + the permission rule', () => {
  it('any member creates; defaults are private + two columns; name is trimmed', async () => {
    const t = await makeTeam();
    const dto = await dashboardsService.create({ name: '  Team overview  ' }, t.memberCtx);
    expect(dto).toMatchObject({
      name: 'Team overview',
      access: 'private',
      layout: 'two',
      owner: { id: t.memberId },
      isOwner: true,
      widgetCount: 0,
    });
  });

  it('rejects blank / over-cap names and unknown access / layout values', async () => {
    const t = await makeTeam();
    await expect(dashboardsService.create({ name: '   ' }, t.ownerCtx)).rejects.toThrow(
      InvalidDashboardNameError,
    );
    await expect(
      dashboardsService.create({ name: 'x'.repeat(DASHBOARD_NAME_MAX_LENGTH + 1) }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardNameError);
    await expect(
      dashboardsService.create({ name: 'ok', access: 'public' }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardAccessError);
    await expect(
      dashboardsService.create({ name: 'ok', layout: 'four' }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardLayoutError);
  });

  it('list: mine + workspace-shared, name-ordered; private rows of others never appear', async () => {
    const t = await makeTeam();
    await dashboardsService.create({ name: 'B own private' }, t.ownerCtx);
    await dashboardsService.create({ name: 'A shared', access: 'workspace' }, t.ownerCtx);
    await dashboardsService.create({ name: 'C member private' }, t.memberCtx);

    const ownerList = await dashboardsService.listDashboards(t.ownerCtx);
    expect(ownerList.map((d) => d.name)).toEqual(['A shared', 'B own private']);

    const memberList = await dashboardsService.listDashboards(t.memberCtx);
    expect(memberList.map((d) => d.name)).toEqual(['A shared', 'C member private']);
    expect(memberList.map((d) => d.isOwner)).toEqual([false, true]);
  });

  it('get: a private dashboard reads as 404 for non-owners (finding #44); shared reads for all', async () => {
    const t = await makeTeam();
    const priv = await dashboardsService.create({ name: 'Private' }, t.ownerCtx);
    const shared = await dashboardsService.create(
      { name: 'Shared', access: 'workspace' },
      t.ownerCtx,
    );
    await expect(dashboardsService.getDashboard(priv.id, t.memberCtx)).rejects.toThrow(
      DashboardNotFoundError,
    );
    const seen = await dashboardsService.getDashboard(shared.id, t.memberCtx);
    expect(seen).toMatchObject({ id: shared.id, isOwner: false, widgets: [] });
  });

  it('cross-tenant ids read as 404 — list, get, and mutate', async () => {
    const t = await makeTeam();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const dash = await dashboardsService.create({ name: 'Mine', access: 'workspace' }, t.ownerCtx);
    expect(await dashboardsService.listDashboards(other.ctx)).toEqual([]);
    await expect(dashboardsService.getDashboard(dash.id, other.ctx)).rejects.toThrow(
      DashboardNotFoundError,
    );
    await expect(dashboardsService.update(dash.id, { name: 'stolen' }, other.ctx)).rejects.toThrow(
      DashboardNotFoundError,
    );
  });

  it('mutate is owner-only: rename / access / layout / delete reject the non-owner (403 shape)', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create(
      { name: 'Shared', access: 'workspace' },
      t.ownerCtx,
    );
    await expect(
      dashboardsService.update(dash.id, { name: 'renamed' }, t.memberCtx),
    ).rejects.toThrow(DashboardForbiddenError);
    await expect(dashboardsService.delete(dash.id, t.memberCtx)).rejects.toThrow(
      DashboardForbiddenError,
    );
    const renamed = await dashboardsService.update(
      dash.id,
      { name: 'Renamed', access: 'private', layout: 'three' },
      t.ownerCtx,
    );
    expect(renamed).toMatchObject({ name: 'Renamed', access: 'private', layout: 'three' });
  });

  it('an access-only change is owner-gated under its own action label', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create(
      { name: 'Shared', access: 'workspace' },
      t.ownerCtx,
    );
    await expect(
      dashboardsService.update(dash.id, { access: 'private' }, t.memberCtx),
    ).rejects.toMatchObject({ action: 'change-access' });
    const updated = await dashboardsService.update(dash.id, { access: 'private' }, t.ownerCtx);
    expect(updated.access).toBe('private');
  });

  it('delete cascades the widgets with the row', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Doomed' }, t.ownerCtx);
    await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    await dashboardsService.delete(dash.id, t.ownerCtx);
    expect(await db.dashboardWidget.count({ where: { dashboardId: dash.id } })).toBe(0);
  });

  it('a layout SHRINK reflows orphaned columns into the new last column, order preserved', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Wide', layout: 'three' }, t.ownerCtx);
    // One widget per column, then a second one in column 2.
    const ids: string[] = [];
    for (const column of [0, 1, 2, 2]) {
      const w = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
      if (column > 0) {
        await dashboardsService.moveWidget(dash.id, w.id, { column }, t.ownerCtx);
      }
      ids.push(w.id);
    }
    await dashboardsService.update(dash.id, { layout: 'one' }, t.ownerCtx);
    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.layout).toBe('one');
    expect(LAYOUT_COLUMN_COUNT[detail.layout]).toBe(1);
    expect(detail.widgets.every((w) => w.column === 0)).toBe(true);
    // Column-0 widget first, then the orphans in their on-grid order.
    expect(detail.widgets.map((w) => w.id)).toEqual([ids[0], ids[1], ids[2], ids[3]]);
  });
});

describe('widgets — registry-gated writes, the cap, and the FK split', () => {
  it('adds all three types, filter- and project-sourced, appended in order', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);

    const a = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    expect(a).toMatchObject({
      type: 'filter_results',
      column: 0,
      config: { pageSize: 50 },
      source: { kind: 'saved_filter', savedFilterId: t.filterId, name: 'High priority' },
      rendererKind: 'issue_table',
      editorKind: 'filter_results_editor',
    });

    const b = await dashboardsService.addWidget(
      dash.id,
      { type: 'distribution', projectId: t.fx.projectId, config: { statisticType: 'status' } },
      t.ownerCtx,
    );
    expect(b).toMatchObject({
      type: 'distribution',
      source: { kind: 'project', projectId: t.fx.projectId, name: t.fx.project.name },
      rendererKind: 'donut',
    });

    const c = await dashboardsService.addWidget(
      dash.id,
      {
        type: 'created_vs_resolved',
        savedFilterId: t.filterId,
        config: { period: 'week', daysBack: 90, cumulative: true },
      },
      t.ownerCtx,
    );
    expect(c).toMatchObject({
      type: 'created_vs_resolved',
      config: { period: 'week', daysBack: 90, cumulative: true },
      rendererKind: 'difference_area',
    });

    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.widgets.map((w) => w.id)).toEqual([a.id, b.id, c.id]);
    expect(detail.widgetCount).toBe(3);
    const positions = detail.widgets.map((w) => w.position);
    expect([...positions].sort()).toEqual(positions);
  });

  it('rejects unknown types, malformed configs, broken XOR, and missing referents (typed 422s)', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    await expect(
      dashboardsService.addWidget(dash.id, { type: 'pie', savedFilterId: t.filterId }, t.ownerCtx),
    ).rejects.toThrow(UnknownDashboardWidgetTypeError);
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', savedFilterId: t.filterId, config: { pageSize: 99 } },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidDashboardWidgetConfigError);
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', savedFilterId: t.filterId, projectId: t.fx.projectId },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidDashboardWidgetConfigError);
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', savedFilterId: 'nope' },
        t.ownerCtx,
      ),
    ).rejects.toThrow(DashboardWidgetSourceNotFoundError);
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', projectId: 'nope' },
        t.ownerCtx,
      ),
    ).rejects.toThrow(DashboardWidgetSourceNotFoundError);
  });

  it('rejects cross-workspace referents and archived projects', async () => {
    const t = await makeTeam();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTX' });
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', projectId: other.projectId },
        t.ownerCtx,
      ),
    ).rejects.toThrow(DashboardWidgetSourceNotFoundError);
    await db.$transaction((tx) => projectRepository.archive(t.fx.projectId, tx));
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'filter_results', projectId: t.fx.projectId },
        t.ownerCtx,
      ),
    ).rejects.toThrow(DashboardWidgetSourceNotFoundError);
  });

  it('widget writes are owner-only', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create(
      { name: 'Shared', access: 'workspace' },
      t.ownerCtx,
    );
    const w = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    await expect(
      dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.memberCtx),
    ).rejects.toThrow(DashboardForbiddenError);
    await expect(
      dashboardsService.updateWidget(dash.id, w.id, { config: { pageSize: 5 } }, t.memberCtx),
    ).rejects.toThrow(DashboardForbiddenError);
    await expect(dashboardsService.removeWidget(dash.id, w.id, t.memberCtx)).rejects.toThrow(
      DashboardForbiddenError,
    );
    await expect(
      dashboardsService.moveWidget(dash.id, w.id, { column: 1 }, t.memberCtx),
    ).rejects.toThrow(DashboardForbiddenError);
  });

  it(`the ${DASHBOARD_MAX_WIDGETS + 1}th widget is the typed cap rejection`, async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Full' }, t.ownerCtx);
    for (let i = 0; i < DASHBOARD_MAX_WIDGETS; i += 1) {
      await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    }
    await expect(
      dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx),
    ).rejects.toThrow(DashboardWidgetCapError);
    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.widgets).toHaveLength(DASHBOARD_MAX_WIDGETS);
  });

  it('updateWidget replaces config and swaps the source; unknown widget is a 404 shape', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    const w = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    const reconfigured = await dashboardsService.updateWidget(
      dash.id,
      w.id,
      { config: { pageSize: 10 }, projectId: t.fx.projectId },
      t.ownerCtx,
    );
    expect(reconfigured).toMatchObject({
      config: { pageSize: 10 },
      source: { kind: 'project', projectId: t.fx.projectId },
    });
    await expect(
      dashboardsService.updateWidget(dash.id, w.id, { config: { pageSize: 0 } }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardWidgetConfigError);
    await expect(
      dashboardsService.updateWidget(dash.id, 'nope', { config: {} }, t.ownerCtx),
    ).rejects.toThrow(DashboardWidgetNotFoundError);
    await dashboardsService.removeWidget(dash.id, w.id, t.ownerCtx);
    await expect(dashboardsService.removeWidget(dash.id, w.id, t.ownerCtx)).rejects.toThrow(
      DashboardWidgetNotFoundError,
    );
  });

  it('deleting the saved filter STALES the widget (SetNull) and reconfiguring heals it', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    const w = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);

    // The 6.2.1 delete-dependents enumeration counts the widget first.
    const dependents = await savedFiltersService.getDependents(
      t.fx.projectIdentifier,
      t.filterId,
      t.ownerCtx,
    );
    expect(dependents.widgetCount).toBe(1);

    await savedFiltersService.delete(t.fx.projectIdentifier, t.filterId, t.ownerCtx);
    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.widgets[0]).toMatchObject({ id: w.id, source: { kind: 'stale' } });

    const healed = await dashboardsService.updateWidget(
      dash.id,
      w.id,
      { projectId: t.fx.projectId },
      t.ownerCtx,
    );
    expect(healed.source).toMatchObject({ kind: 'project', projectId: t.fx.projectId });
  });

  it('a stored config a later registry rejects degrades on the read, never crashes it', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    const w = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    // Simulate a config persisted by an older, looser registry version.
    await db.dashboardWidget.update({
      where: { id: w.id },
      data: { config: { pageSize: 9999, legacyKey: true } },
    });
    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.widgets[0]!.config).toEqual({ pageSize: 9999, legacyKey: true });
  });

  it('deleting a project CASCADES its project-sourced widgets away', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx);
    const w = await dashboardsService.addWidget(
      dash.id,
      { type: 'filter_results', projectId: t.fx.projectId },
      t.ownerCtx,
    );
    await db.project.delete({ where: { id: t.fx.projectId } });
    const detail = await dashboardsService.getDashboard(dash.id, t.ownerCtx);
    expect(detail.widgets.map((x) => x.id)).not.toContain(w.id);
  });
});

describe('move — server-minted fractional ordering (the 3.2 pattern)', () => {
  async function gridOrder(dashboardId: string, ctx: ServiceContext): Promise<string[][]> {
    const detail = await dashboardsService.getDashboard(dashboardId, ctx);
    const columns: string[][] = [[], [], []];
    for (const w of detail.widgets) columns[w.column]!.push(w.id);
    return columns;
  }

  it('moves between and within columns against neighbour bounds', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid', layout: 'three' }, t.ownerCtx);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx)).id);
    }
    const [a, b, c, d] = ids as [string, string, string, string];

    // Bare {column} appends to an empty column.
    await dashboardsService.moveWidget(dash.id, b, { column: 1 }, t.ownerCtx);
    // beforeId prepends.
    await dashboardsService.moveWidget(dash.id, d, { column: 1, beforeId: b }, t.ownerCtx);
    // afterId + beforeId lands between.
    await dashboardsService.moveWidget(
      dash.id,
      a,
      { column: 1, afterId: d, beforeId: b },
      t.ownerCtx,
    );
    expect(await gridOrder(dash.id, t.ownerCtx)).toEqual([[c], [d, a, b], []]);

    // In-column reorder: c is alone in 0; move it after b in 1, then to the front.
    await dashboardsService.moveWidget(dash.id, c, { column: 1, afterId: b }, t.ownerCtx);
    await dashboardsService.moveWidget(dash.id, c, { column: 1, beforeId: d }, t.ownerCtx);
    expect(await gridOrder(dash.id, t.ownerCtx)).toEqual([[], [c, d, a, b], []]);
  });

  it('a churning move sequence keeps positions strictly ordered and unique', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Churn' }, t.ownerCtx);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx)).id);
    }
    // Rotate the front widget to the back 9 times — the fractional keys must
    // stay unique + sorted through every intermediate state.
    for (let i = 0; i < 9; i += 1) {
      const order = (await dashboardsService.getDashboard(dash.id, t.ownerCtx)).widgets;
      const front = order[0]!;
      await dashboardsService.moveWidget(
        dash.id,
        front.id,
        { column: 0, afterId: order.at(-1)!.id },
        t.ownerCtx,
      );
      const after = (await dashboardsService.getDashboard(dash.id, t.ownerCtx)).widgets;
      const positions = after.map((w) => w.position);
      expect(new Set(positions).size).toBe(positions.length);
      expect([...positions].sort()).toEqual(positions);
      expect(after.at(-1)!.id).toBe(front.id);
    }
    // Three full rotations land the original order back.
    const final = (await dashboardsService.getDashboard(dash.id, t.ownerCtx)).widgets;
    expect(final.map((w) => w.id)).toEqual(ids);
  });

  it('rejects out-of-layout columns and neighbours that do not bound a slot', async () => {
    const t = await makeTeam();
    const dash = await dashboardsService.create({ name: 'Grid' }, t.ownerCtx); // two columns
    const a = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    const b = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    await expect(
      dashboardsService.moveWidget(dash.id, a.id, { column: 2 }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardWidgetMoveError);
    await expect(
      dashboardsService.moveWidget(dash.id, a.id, { column: -1 }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardWidgetMoveError);
    // b lives in column 0 — naming it as a column-1 neighbour is a 422.
    await expect(
      dashboardsService.moveWidget(dash.id, a.id, { column: 1, afterId: b.id }, t.ownerCtx),
    ).rejects.toThrow(InvalidDashboardWidgetMoveError);
    // Out-of-order bounds.
    const c = await dashboardsService.addWidget(dash.id, filterWidgetInput(t), t.ownerCtx);
    await expect(
      dashboardsService.moveWidget(
        dash.id,
        a.id,
        { column: 0, afterId: c.id, beforeId: b.id },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidDashboardWidgetMoveError);
    await expect(
      dashboardsService.moveWidget(dash.id, 'nope', { column: 0 }, t.ownerCtx),
    ).rejects.toThrow(DashboardWidgetNotFoundError);
  });
});

describe('route transport — the HTTP layer enforces the same matrix', () => {
  const BASE = 'http://localhost:3000/api/dashboards';

  function paramsFor<T>(value: T): { params: Promise<T> } {
    return { params: Promise.resolve(value) };
  }
  function jsonReq(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('401s every route without a workspace context', async () => {
    wsCtx.current = null;
    const p = paramsFor({ dashboardId: 'x' });
    const wp = paramsFor({ dashboardId: 'x', widgetId: 'y' });
    const responses = await Promise.all([
      listGET(),
      createPOST(jsonReq(BASE, 'POST', { name: 'n' })),
      detailGET(jsonReq(`${BASE}/x`, 'GET'), p),
      dashboardPATCH(jsonReq(`${BASE}/x`, 'PATCH', { name: 'n' }), p),
      dashboardDELETE(jsonReq(`${BASE}/x`, 'DELETE'), p),
      widgetPOST(jsonReq(`${BASE}/x/widgets`, 'POST', { type: 'filter_results' }), p),
      widgetPATCH(jsonReq(`${BASE}/x/widgets/y`, 'PATCH', { config: {} }), wp),
      widgetDELETE(jsonReq(`${BASE}/x/widgets/y`, 'DELETE'), wp),
      movePOST(jsonReq(`${BASE}/x/widgets/y/move`, 'POST', { column: 0 }), wp),
    ]);
    for (const res of responses) expect(res.status).toBe(401);
  });

  it('walks the lifecycle: create 201 → list → get → patch → widget add 201 → move → delete 204', async () => {
    const t = await makeTeam();
    wsCtx.current = t.ownerCtx;

    const createRes = await createPOST(jsonReq(BASE, 'POST', { name: 'Ops', access: 'workspace' }));
    expect(createRes.status).toBe(201);
    const { dashboard } = (await createRes.json()) as { dashboard: { id: string } };

    const listRes = await listGET();
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { dashboards: unknown[] }).dashboards).toHaveLength(1);

    const addRes = await widgetPOST(
      jsonReq(`${BASE}/${dashboard.id}/widgets`, 'POST', {
        type: 'distribution',
        savedFilterId: t.filterId,
        config: { statisticType: 'status' },
      }),
      paramsFor({ dashboardId: dashboard.id }),
    );
    expect(addRes.status).toBe(201);
    const { widget } = (await addRes.json()) as { widget: { id: string } };

    const moveRes = await movePOST(
      jsonReq(`${BASE}/${dashboard.id}/widgets/${widget.id}/move`, 'POST', { column: 1 }),
      paramsFor({ dashboardId: dashboard.id, widgetId: widget.id }),
    );
    expect(moveRes.status).toBe(200);

    const patchRes = await dashboardPATCH(
      jsonReq(`${BASE}/${dashboard.id}`, 'PATCH', { layout: 'three' }),
      paramsFor({ dashboardId: dashboard.id }),
    );
    expect(patchRes.status).toBe(200);

    const getRes = await detailGET(
      jsonReq(`${BASE}/${dashboard.id}`, 'GET'),
      paramsFor({ dashboardId: dashboard.id }),
    );
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      dashboard: { layout: string; widgets: Array<{ id: string; column: number }> };
    };
    expect(detail.dashboard.layout).toBe('three');
    expect(detail.dashboard.widgets).toEqual([
      expect.objectContaining({ id: widget.id, column: 1 }),
    ]);

    const widgetDelRes = await widgetDELETE(
      jsonReq(`${BASE}/${dashboard.id}/widgets/${widget.id}`, 'DELETE'),
      paramsFor({ dashboardId: dashboard.id, widgetId: widget.id }),
    );
    expect(widgetDelRes.status).toBe(204);

    const delRes = await dashboardDELETE(
      jsonReq(`${BASE}/${dashboard.id}`, 'DELETE'),
      paramsFor({ dashboardId: dashboard.id }),
    );
    expect(delRes.status).toBe(204);
  });

  it('maps the typed errors: 404 private, 403 non-owner, 422 invalid input, 400 malformed', async () => {
    const t = await makeTeam();
    wsCtx.current = t.ownerCtx;
    const priv = await dashboardsService.create({ name: 'Private' }, t.ownerCtx);
    const shared = await dashboardsService.create(
      { name: 'Shared', access: 'workspace' },
      t.ownerCtx,
    );

    wsCtx.current = t.memberCtx;
    const get404 = await detailGET(
      jsonReq(`${BASE}/${priv.id}`, 'GET'),
      paramsFor({ dashboardId: priv.id }),
    );
    expect(get404.status).toBe(404);
    const patch403 = await dashboardPATCH(
      jsonReq(`${BASE}/${shared.id}`, 'PATCH', { name: 'taken' }),
      paramsFor({ dashboardId: shared.id }),
    );
    expect(patch403.status).toBe(403);

    wsCtx.current = t.ownerCtx;
    const create422 = await createPOST(jsonReq(BASE, 'POST', { name: 'x', access: 'public' }));
    expect(create422.status).toBe(422);
    const widget422 = await widgetPOST(
      jsonReq(`${BASE}/${shared.id}/widgets`, 'POST', { type: 'pie', savedFilterId: t.filterId }),
      paramsFor({ dashboardId: shared.id }),
    );
    expect(widget422.status).toBe(422);
    const move422 = await movePOST(
      jsonReq(`${BASE}/${shared.id}/widgets/nope/move`, 'POST', { column: 9 }),
      paramsFor({ dashboardId: shared.id, widgetId: 'nope' }),
    );
    expect(move422.status).toBe(404); // unknown widget outranks the bad column

    const badJson = await createPOST(new Request(BASE, { method: 'POST', body: 'not json{' }));
    expect(badJson.status).toBe(400);
    const emptyPatch = await dashboardPATCH(
      jsonReq(`${BASE}/${shared.id}`, 'PATCH', {}),
      paramsFor({ dashboardId: shared.id }),
    );
    expect(emptyPatch.status).toBe(400);
  });
});

describe('repo empty-input guards (the coverage-gate rule)', () => {
  it('blank ids read as null / empty / zero, never a throw', async () => {
    const t = await makeTeam();
    expect(await dashboardRepository.findByIdWithFacts('', 'x')).toBeNull();
    expect(await dashboardRepository.findByIdWithFacts(t.fx.workspaceId, '')).toBeNull();
    expect(await dashboardRepository.listVisible('', t.fx.ownerId, 10)).toEqual([]);
    expect(await dashboardRepository.listVisible(t.fx.workspaceId, '', 10)).toEqual([]);
    expect(await dashboardWidgetRepository.listByDashboard('')).toEqual([]);
    expect(await dashboardWidgetRepository.findByIdWithNames('', 'w')).toBeNull();
    expect(await dashboardWidgetRepository.findByIdWithNames('d', '')).toBeNull();
    expect(await dashboardWidgetRepository.countBySavedFilter('')).toBe(0);
    await db.$transaction(async (tx) => {
      expect(await dashboardRepository.lockById('', 'x', tx)).toBeNull();
      expect(await dashboardRepository.lockById(t.fx.workspaceId, '', tx)).toBeNull();
      expect(await dashboardWidgetRepository.countByDashboard('', tx)).toBe(0);
    });
  });
});
