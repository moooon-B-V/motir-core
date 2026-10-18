// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { WIDGET_REGISTRY, WIDGET_TYPES } from '@/lib/dashboards/widgetRegistry';
import type { DashboardWidgetType } from '@/generated/prisma/client';
import type { ReportWidgetResultDto } from '@/lib/dto/reports';
import { AddWidgetModal } from '@/app/(authed)/dashboard/_components/AddWidgetModal';
import {
  WidgetConfigModal,
  emptyDraft,
} from '@/app/(authed)/dashboard/_components/WidgetConfigModal';
import { AgeReportBody } from '@/app/(authed)/dashboard/_components/AgeReportBody';
import { CreatedVsResolvedBody } from '@/app/(authed)/dashboard/_components/CreatedVsResolvedBody';
import { WorkloadBody } from '@/app/(authed)/dashboard/_components/WorkloadBody';
import { DistributionBody } from '@/app/(authed)/dashboard/_components/DistributionBody';
import { FilterResultsBody } from '@/app/(authed)/dashboard/_components/FilterResultsBody';
import {
  WidgetEmpty,
  WidgetNoAccess,
  WidgetStale,
} from '@/app/(authed)/dashboard/_components/WidgetStateView';

// Dashboard widget UI (Subtask 6.3.5): the registry-driven add picker + config
// panels, the per-widget state envelope, and the renderers over the mocked
// 6.3.2 reads. Rendered with the real `en` catalog (renderWithIntl). The dnd
// grid interaction itself is the 6.3.7 E2E's surface; the optimistic placement
// logic is covered in dashboard-grid-model.test.ts.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

function withToast(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AddWidgetModal — rendered FROM the widget registry', () => {
  it('renders exactly one picker card per registered widget type', () => {
    withToast(<AddWidgetModal open onOpenChange={() => {}} onPick={() => {}} />);
    for (const type of WIDGET_TYPES) {
      expect(screen.getByTestId(`add-widget-${type}`)).toBeTruthy();
    }
    // No hard-coded list: the card count tracks the registry exactly.
    const cards = WIDGET_TYPES.map((t) => screen.getByTestId(`add-widget-${t}`));
    expect(cards).toHaveLength(WIDGET_TYPES.length);
  });

  it('picks a type with its registry editor kind', () => {
    const onPick = vi.fn();
    withToast(<AddWidgetModal open onOpenChange={() => {}} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('add-widget-distribution'));
    expect(onPick).toHaveBeenCalledWith('distribution', 'distribution_editor');
  });
});

const PROJECTS = [{ id: 'p1', name: 'Motir', identifier: 'PROD' }];

function configModal(
  over: {
    mode?: 'create' | 'edit';
    type?: DashboardWidgetType;
    editorKind?: string;
    initial?: ReturnType<typeof emptyDraft>;
    widgetId?: string;
  } = {},
) {
  return (
    <WidgetConfigModal
      open
      onOpenChange={() => {}}
      mode={over.mode ?? 'create'}
      type={over.type ?? 'distribution'}
      editorKind={over.editorKind ?? 'distribution_editor'}
      dashboardId="d1"
      widgetId={over.widgetId}
      projects={PROJECTS}
      initial={over.initial}
      onSaved={() => {}}
    />
  );
}

describe('WidgetConfigModal — registry-driven editor kinds + the data-source XOR', () => {
  it('disables Save until a data source (and statistic) is chosen', () => {
    withToast(configModal({ mode: 'create', editorKind: 'distribution_editor' }));
    const save = screen.getByTestId('widget-config-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('enables Save once a project source + statistic are set (the XOR satisfied)', () => {
    const initial = {
      ...emptyDraft(),
      source: { kind: 'project' as const, savedFilterId: null, projectId: 'p1' },
      statisticType: 'status',
    };
    withToast(configModal({ mode: 'edit', widgetId: 'w1', initial }));
    const save = screen.getByTestId('widget-config-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('renders the distribution editor kind (statistic type control)', () => {
    withToast(configModal({ editorKind: 'distribution_editor' }));
    expect(screen.getByText('Statistic type')).toBeTruthy();
  });

  it('renders the created-vs-resolved editor kind (period / days / cumulative)', () => {
    withToast(
      configModal({
        type: 'created_vs_resolved',
        editorKind: 'created_vs_resolved_editor',
      }),
    );
    expect(screen.getByText('Period')).toBeTruthy();
    expect(screen.getByText('Days back')).toBeTruthy();
    expect(screen.getByText('Cumulative')).toBeTruthy();
  });

  it('the cumulative switch is the design-system Switch, named and toggled by its visible label (MOTIR-5735)', () => {
    withToast(
      configModal({
        type: 'created_vs_resolved',
        editorKind: 'created_vs_resolved_editor',
      }),
    );
    // The accessible name comes from the visible label, not from text inside
    // the button (the old hand-rolled Toggle rendered the label inside it).
    const toggle = screen.getByRole('switch', { name: 'Cumulative' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The primitive paints the Switch-scoped tokens the contrast suite measures.
    expect(toggle.className).toContain('bg-(--el-muted)');
    expect(toggle.className).toContain('border-(--el-switch-off-border)');
    // The label stays a click target for the switch.
    fireEvent.click(screen.getByText('Cumulative'));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('renders the filter-results editor kind (rows per page)', () => {
    withToast(configModal({ type: 'filter_results', editorKind: 'filter_results_editor' }));
    expect(screen.getByText('Rows per page')).toBeTruthy();
  });
});

describe('Widget state views', () => {
  it('renders the empty / no-access / stale bodies as TEXT (finding #35)', () => {
    renderWithIntl(<WidgetEmpty />);
    expect(screen.getByText('No matching work items')).toBeTruthy();
    cleanup();
    renderWithIntl(<WidgetNoAccess />);
    expect(screen.getByText('No access')).toBeTruthy();
    cleanup();
    renderWithIntl(<WidgetStale />);
    expect(screen.getByText('Filter missing')).toBeTruthy();
  });
});

// ── Renderers over the mocked 6.3.2 reads ──

function mockReportFetch<T>(result: ReportWidgetResultDto<T>) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => result,
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const PROJECT_SOURCE = { kind: 'project' as const, projectId: 'p1', name: 'Motir' };

describe('DistributionBody (donut renderer)', () => {
  it('renders the segments as count + percentage when the read is ok', async () => {
    mockReportFetch({
      state: 'ok',
      data: {
        statistic: 'status',
        total: 50,
        segments: [
          { id: 'todo', label: 'To Do', count: 30, percentage: 60 },
          { id: 'done', label: 'Done', count: 20, percentage: 40 },
        ],
      },
    });
    renderWithIntl(
      <DistributionBody source={PROJECT_SOURCE} config={{ statisticType: 'status' }} />,
    );
    await waitFor(() => expect(screen.getAllByText('To Do').length).toBeGreaterThan(0));
    expect(screen.getAllByText('30').length).toBeGreaterThan(0);
  });

  it('renders the no-access state without leaking counts', async () => {
    mockReportFetch({ state: 'no_access' });
    renderWithIntl(
      <DistributionBody source={PROJECT_SOURCE} config={{ statisticType: 'status' }} />,
    );
    await waitFor(() => expect(screen.getByText('No access')).toBeTruthy());
  });

  it('renders the empty state for zero total', async () => {
    mockReportFetch({ state: 'ok', data: { statistic: 'status', total: 0, segments: [] } });
    renderWithIntl(
      <DistributionBody source={PROJECT_SOURCE} config={{ statisticType: 'status' }} />,
    );
    await waitFor(() => expect(screen.getByText('No matching work items')).toBeTruthy());
  });

  it('short-circuits a stale source to the filter-missing card (no fetch)', () => {
    const spy = mockReportFetch({ state: 'ok', data: { statistic: 's', total: 0, segments: [] } });
    renderWithIntl(<DistributionBody source={{ kind: 'stale' }} config={{ statisticType: 's' }} />);
    expect(screen.getByText('Filter missing')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('FilterResultsBody (issue-table renderer)', () => {
  it('renders a page of rows + the pager range', async () => {
    mockReportFetch({
      state: 'ok',
      data: {
        items: [
          {
            id: 'wi1',
            kind: 'bug',
            key: 412,
            identifier: 'PROD-412',
            title: 'Export crashes on empty range',
            status: 'todo',
            priority: 'highest',
            assigneeId: 'u1',
            reporterId: 'u2',
            dueDate: null,
            estimateMinutes: null,
            storyPoints: null,
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        total: 23,
        page: 1,
        pageSize: 4,
      },
    });
    renderWithIntl(<FilterResultsBody source={PROJECT_SOURCE} config={{ pageSize: 4 }} />);
    await waitFor(() => expect(screen.getByText('PROD-412')).toBeTruthy());
    expect(screen.getByText('Export crashes on empty range')).toBeTruthy();
    expect(screen.getByText('1–4 of 23')).toBeTruthy();
  });
});

// ── Story MOTIR-8919 · story gate, cases 12–13: the tiles do not move ──
//
// The report pages gained a page mode, thinned x labels, segments and a help
// text; the dashboard tiles share the chart primitives that changed and must
// render exactly as before. Each tile is rendered with FIXED props and its chart
// SVG is pinned as an inline snapshot RECORDED AT THE STORY'S MERGE BASE (the
// cases were run with `-u` in a scratch checkout of that commit and carried over
// unchanged), so a match at the head means the primitives' default mode is
// byte-for-byte what it was: same viewBox, classes, tick text, bar rects, no
// segment rects and no help text.

const TILE_SOURCE = PROJECT_SOURCE;

async function tileSvg(container: HTMLElement): Promise<string> {
  await waitFor(() => expect(container.querySelector('svg[role="img"]')).toBeTruthy());
  return container.querySelector('svg[role="img"]')!.outerHTML;
}

describe('dashboard tiles render the shared charts unchanged (story gate D12)', () => {
  it('workload', async () => {
    mockReportFetch({
      state: 'ok',
      data: {
        measure: 'story_points',
        assignees: [
          {
            assigneeId: 'u1',
            name: 'Ana',
            points: 13,
            count: 4,
            assignedPoints: 13,
            assignedCount: 4,
            unassignedPoints: 0,
            unassignedCount: 0,
          },
          {
            assigneeId: 'u2',
            name: 'Bo',
            points: 5,
            count: 2,
            assignedPoints: 5,
            assignedCount: 2,
            unassignedPoints: 0,
            unassignedCount: 0,
          },
          {
            assigneeId: null,
            name: null,
            points: 3,
            count: 1,
            assignedPoints: 0,
            assignedCount: 0,
            unassignedPoints: 0,
            unassignedCount: 0,
          },
        ],
        totalPoints: 21,
        totalCount: 7,
        window: null,
      },
    });
    const { container } = renderWithIntl(
      <WorkloadBody source={TILE_SOURCE} config={{ measure: 'story_points' }} />,
    );
    const svg = await tileSvg(container);
    expect(screen.queryByText('Hide help text')).toBeNull();
    expect(screen.queryByText('Show help text')).toBeNull();
    expect(svg).toMatchInlineSnapshot(
      `"<svg viewBox="0 0 600 163" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Open work per assignee, ranked." aria-describedby="_r_12_" class="block h-auto w-full"><desc id="_r_12_">Open work per assignee, ranked.</desc><rect x="132" y="26" width="428" height="111" rx="4" class="fill-(--el-chart-plot)"></rect><g class="stroke-(--el-chart-grid)" stroke-width="1"><line x1="132" x2="132" y1="26" y2="137"></line><line x1="274.66666666666663" x2="274.66666666666663" y1="26" y2="137"></line><line x1="417.3333333333333" x2="417.3333333333333" y1="26" y2="137"></line><line x1="560" x2="560" y1="26" y2="137"></line></g><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="middle"><text x="132" y="153">0</text><text x="274.66666666666663" y="153">5</text><text x="417.3333333333333" y="153">10</text><text x="560" y="153">15</text></g><text class="fill-(--el-chart-axis) text-[11px]" x="346" y="12" text-anchor="middle">Story points</text><g><text class="fill-(--el-text-secondary) text-[12px]" x="124" y="48.5" text-anchor="end">Ana</text><rect x="132" y="33.5" width="370.93333333333334" height="22" rx="3" fill="var(--el-chart-cat-1)"></rect><text class="fill-(--el-text) text-[12px] font-semibold" x="510.93333333333334" y="48.5" text-anchor="start">13</text></g><g><text class="fill-(--el-text-secondary) text-[12px]" x="124" y="85.5" text-anchor="end">Bo</text><rect x="132" y="70.5" width="142.66666666666663" height="22" rx="3" fill="var(--el-chart-cat-2)"></rect><text class="fill-(--el-text) text-[12px] font-semibold" x="282.66666666666663" y="85.5" text-anchor="start">5</text></g><g><text class="fill-(--el-text-secondary) text-[12px]" x="124" y="122.5" text-anchor="end">Unassigned</text><rect x="132" y="107.5" width="85.60000000000002" height="22" rx="3" fill="var(--el-chart-cat-none)"></rect><text class="fill-(--el-text) text-[12px] font-semibold" x="225.60000000000002" y="122.5" text-anchor="start">3</text></g><line x1="132" y1="26" x2="132" y2="137" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line></svg>"`,
    );
  });

  it('created vs resolved', async () => {
    mockReportFetch({
      state: 'ok',
      data: {
        period: 'week',
        daysBack: 30,
        cumulative: false,
        windowStart: '2026-01-01T00:00:00.000Z',
        windowEnd: '2026-01-29T00:00:00.000Z',
        buckets: [
          { date: '2026-01-05', created: 8, resolved: 5 },
          { date: '2026-01-12', created: 4, resolved: 9 },
          { date: '2026-01-19', created: 6, resolved: 6 },
          { date: '2026-01-26', created: 2, resolved: 7 },
        ],
      },
    });
    const { container } = renderWithIntl(
      <CreatedVsResolvedBody
        source={TILE_SOURCE}
        config={{ period: 'week', daysBack: 30, cumulative: false }}
      />,
    );
    expect(await tileSvg(container)).toMatchInlineSnapshot(
      `"<svg viewBox="0 0 560 240" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Work items created versus resolved per week over the last 30 days." aria-describedby="_r_13_" class="block w-full h-auto"><desc id="_r_13_">Work items created versus resolved per week over the last 30 days.</desc><rect x="44" y="16" width="500" height="178" rx="4" class="fill-(--el-chart-plot)"></rect><g class="stroke-(--el-chart-grid)" stroke-width="1"><line x1="44" x2="544" y1="194" y2="194"></line><line x1="44" x2="544" y1="158.4" y2="158.4"></line><line x1="44" x2="544" y1="122.8" y2="122.8"></line><line x1="44" x2="544" y1="87.2" y2="87.2"></line><line x1="44" x2="544" y1="51.599999999999994" y2="51.599999999999994"></line><line x1="44" x2="544" y1="16" y2="16"></line></g><line x1="44" y1="16" x2="44" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><line x1="44" y1="194" x2="544" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="end"><text x="38" y="198">0</text><text x="38" y="162.4">2</text><text x="38" y="126.8">4</text><text x="38" y="91.2">6</text><text x="38" y="55.599999999999994">8</text><text x="38" y="20">10</text></g><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="middle"><text x="44" y="212">Jan 5</text><text x="210.66666666666666" y="212">Jan 12</text><text x="377.3333333333333" y="212">Jan 19</text><text x="544" y="212">Jan 26</text></g><text class="fill-(--el-chart-axis) text-[11px]" x="294" y="234" text-anchor="middle">week</text><path d="M44,51.6 L106.5,78.3 L44,105 Z" fill="var(--el-chart-deficit)" opacity="0.2" stroke="none"></path><path d="M106.5,78.3 L210.67,122.8 L210.67,33.8 Z" fill="var(--el-chart-surplus)" opacity="0.2" stroke="none"></path><path d="M210.67,122.8 L377.33,87.2 L377.33,87.2 L210.67,33.8 Z" fill="var(--el-chart-surplus)" opacity="0.2" stroke="none"></path><path d="M377.33,87.2 L544,158.4 L544,69.4 L377.33,87.2 Z" fill="var(--el-chart-surplus)" opacity="0.2" stroke="none"></path><path d="M44,51.6 L210.67,122.8 L377.33,87.2 L544,158.4" fill="none" stroke="var(--el-chart-created)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M44,105 L210.67,33.8 L377.33,87.2 L544,69.4" fill="none" stroke="var(--el-chart-resolved)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>"`,
    );
  });

  async function ageTileSvg(type: 'average_age' | 'resolution_time'): Promise<string> {
    mockReportFetch({
      state: 'ok',
      data: {
        period: 'week',
        daysBack: 30,
        windowStart: '2026-01-01T00:00:00.000Z',
        windowEnd: '2026-01-29T00:00:00.000Z',
        windowAverage: 6,
        buckets: [
          { date: '2026-01-05', avgDays: 4, count: 3 },
          { date: '2026-01-12', avgDays: 9, count: 2 },
          { date: '2026-01-19', avgDays: null, count: 0 },
          { date: '2026-01-26', avgDays: 5, count: 4 },
        ],
      },
    });
    const { container } = renderWithIntl(
      <AgeReportBody type={type} source={TILE_SOURCE} config={{ period: 'week', daysBack: 30 }} />,
    );
    return tileSvg(container);
  }

  it('average age', async () => {
    expect(await ageTileSvg('average_age')).toMatchInlineSnapshot(
      `"<svg viewBox="0 0 560 240" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Average age of unresolved work items per week over the last 30 days." aria-describedby="_r_14_" class="block w-full h-auto"><desc id="_r_14_">Average age of unresolved work items per week over the last 30 days.</desc><rect x="44" y="16" width="500" height="178" rx="4" class="fill-(--el-chart-plot)"></rect><g class="stroke-(--el-chart-grid)" stroke-width="1"><line x1="44" x2="544" y1="194" y2="194"></line><line x1="44" x2="544" y1="158.4" y2="158.4"></line><line x1="44" x2="544" y1="122.8" y2="122.8"></line><line x1="44" x2="544" y1="87.2" y2="87.2"></line><line x1="44" x2="544" y1="51.599999999999994" y2="51.599999999999994"></line><line x1="44" x2="544" y1="16" y2="16"></line></g><line x1="44" y1="16" x2="44" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><line x1="44" y1="194" x2="544" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="end"><text x="38" y="198">0</text><text x="38" y="162.4">2</text><text x="38" y="126.8">4</text><text x="38" y="91.2">6</text><text x="38" y="55.599999999999994">8</text><text x="38" y="20">10</text></g><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="middle"><text x="106.5" y="212">Jan 5</text><text x="231.5" y="212">Jan 12</text><text x="356.5" y="212">Jan 19</text><text x="481.5" y="212">Jan 26</text></g><text class="fill-(--el-chart-axis) text-[11px]" x="14" y="105" text-anchor="middle" transform="rotate(-90 14 105)">Days</text><text class="fill-(--el-chart-axis) text-[11px]" x="294" y="234" text-anchor="middle">week</text><g><g><rect x="67.75" y="122.8" width="77.5" height="71.2" rx="2" fill="var(--el-chart-age)"></rect><text class="text-[11px] font-semibold" x="106.5" y="117.8" fill="var(--el-chart-age)" text-anchor="middle">4</text></g></g><g><g><rect x="192.75" y="33.79999999999998" width="77.5" height="160.20000000000002" rx="2" fill="var(--el-chart-age)"></rect><text class="text-[11px] font-semibold" x="231.5" y="28.799999999999983" fill="var(--el-chart-age)" text-anchor="middle">9</text></g></g><g><g><rect x="317.75" y="194" width="77.5" height="0" rx="2" fill="var(--el-chart-age)"></rect><text class="text-[11px] font-semibold" x="356.5" y="189" fill="var(--el-chart-age)" text-anchor="middle">—</text></g></g><g><g><rect x="442.75" y="105" width="77.5" height="89" rx="2" fill="var(--el-chart-age)"></rect><text class="text-[11px] font-semibold" x="481.5" y="100" fill="var(--el-chart-age)" text-anchor="middle">5</text></g></g><g><line x1="44" x2="544" y1="87.2" y2="87.2" stroke="var(--el-chart-average)" stroke-width="1.75" stroke-dasharray="6 4"></line><text class="text-[10.5px] font-semibold font-mono" x="50" y="83.2" fill="var(--el-chart-average)">avg 6d</text></g></svg>"`,
    );
  });

  it('resolution time', async () => {
    expect(await ageTileSvg('resolution_time')).toMatchInlineSnapshot(
      `"<svg viewBox="0 0 560 240" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Average resolution time per week over the last 30 days." aria-describedby="_r_15_" class="block w-full h-auto"><desc id="_r_15_">Average resolution time per week over the last 30 days.</desc><rect x="44" y="16" width="500" height="178" rx="4" class="fill-(--el-chart-plot)"></rect><g class="stroke-(--el-chart-grid)" stroke-width="1"><line x1="44" x2="544" y1="194" y2="194"></line><line x1="44" x2="544" y1="158.4" y2="158.4"></line><line x1="44" x2="544" y1="122.8" y2="122.8"></line><line x1="44" x2="544" y1="87.2" y2="87.2"></line><line x1="44" x2="544" y1="51.599999999999994" y2="51.599999999999994"></line><line x1="44" x2="544" y1="16" y2="16"></line></g><line x1="44" y1="16" x2="44" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><line x1="44" y1="194" x2="544" y2="194" class="stroke-(--el-chart-axis)" stroke-width="1.5"></line><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="end"><text x="38" y="198">0</text><text x="38" y="162.4">2</text><text x="38" y="126.8">4</text><text x="38" y="91.2">6</text><text x="38" y="55.599999999999994">8</text><text x="38" y="20">10</text></g><g class="fill-(--el-chart-axis) text-[11px]" text-anchor="middle"><text x="106.5" y="212">Jan 5</text><text x="231.5" y="212">Jan 12</text><text x="356.5" y="212">Jan 19</text><text x="481.5" y="212">Jan 26</text></g><text class="fill-(--el-chart-axis) text-[11px]" x="14" y="105" text-anchor="middle" transform="rotate(-90 14 105)">Days</text><text class="fill-(--el-chart-axis) text-[11px]" x="294" y="234" text-anchor="middle">week</text><g><g><rect x="67.75" y="122.8" width="77.5" height="71.2" rx="2" fill="var(--el-chart-resolution)"></rect><text class="text-[11px] font-semibold" x="106.5" y="117.8" fill="var(--el-chart-resolution)" text-anchor="middle">4</text></g></g><g><g><rect x="192.75" y="33.79999999999998" width="77.5" height="160.20000000000002" rx="2" fill="var(--el-chart-resolution)"></rect><text class="text-[11px] font-semibold" x="231.5" y="28.799999999999983" fill="var(--el-chart-resolution)" text-anchor="middle">9</text></g></g><g><g><rect x="317.75" y="194" width="77.5" height="0" rx="2" fill="var(--el-chart-resolution)"></rect><text class="text-[11px] font-semibold" x="356.5" y="189" fill="var(--el-chart-resolution)" text-anchor="middle">—</text></g></g><g><g><rect x="442.75" y="105" width="77.5" height="89" rx="2" fill="var(--el-chart-resolution)"></rect><text class="text-[11px] font-semibold" x="481.5" y="100" fill="var(--el-chart-resolution)" text-anchor="middle">5</text></g></g><g><line x1="44" x2="544" y1="87.2" y2="87.2" stroke="var(--el-chart-average)" stroke-width="1.75" stroke-dasharray="6 4"></line><text class="text-[10.5px] font-semibold font-mono" x="50" y="83.2" fill="var(--el-chart-average)">avg 6d</text></g></svg>"`,
    );
  });

  it('distribution', async () => {
    mockReportFetch({
      state: 'ok',
      data: {
        statistic: 'status',
        total: 10,
        segments: [
          { id: 'todo', label: 'To Do', count: 6, percentage: 60 },
          { id: 'done', label: 'Done', count: 4, percentage: 40 },
        ],
      },
    });
    const { container } = renderWithIntl(
      <DistributionBody source={TILE_SOURCE} config={{ statisticType: 'status' }} />,
    );
    expect(await tileSvg(container)).toMatchInlineSnapshot(
      `"<svg viewBox="0 0 220 220" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Donut of 10 work items grouped by Status." aria-describedby="_r_16_" class="block h-auto shrink-0" style="width: 156.2px;"><desc id="_r_16_">Donut of 10 work items grouped by Status.</desc><path d="M110,18.04 A91.96000000000001 91.96000000000001 0 1 1 55.95,184.4 L78.27,153.67 A53.98052 53.98052 0 1 0 110,56.02 Z" fill="var(--el-chart-cat-1)" fill-rule="evenodd"></path><path d="M55.95,184.4 A91.96000000000001 91.96000000000001 0 0 1 110,18.04 L110,56.02 A53.98052 53.98052 0 0 0 78.27,153.67 Z" fill="var(--el-chart-cat-2)" fill-rule="evenodd"></path><text x="110" y="108" text-anchor="middle" class="fill-(--el-text) font-semibold" style="font-size: 27.94px;">10</text><text x="110" y="124.08" text-anchor="middle" class="fill-(--el-text-muted)" style="font-size: 12.1px;">work items</text></svg>"`,
    );
  });
});

describe('the workload tile cannot ask for a window (story gate D13)', () => {
  it('parseConfig rejects period and daysBack and still accepts measure', () => {
    const def = WIDGET_REGISTRY.workload;
    expect(() => def.parseConfig({ measure: 'story_points', period: 'week' })).toThrow();
    expect(() => def.parseConfig({ measure: 'issue_count', daysBack: 30 })).toThrow();
    expect(def.parseConfig({ measure: 'issue_count' })).toEqual({ measure: 'issue_count' });
    expect(def.parseConfig({})).toEqual({ measure: 'story_points' });
  });
});
