// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { WIDGET_TYPES } from '@/lib/dashboards/widgetRegistry';
import type { DashboardWidgetType } from '@prisma/client';
import type { ReportWidgetResultDto } from '@/lib/dto/reports';
import { AddWidgetModal } from '@/app/(authed)/dashboard/_components/AddWidgetModal';
import {
  WidgetConfigModal,
  emptyDraft,
} from '@/app/(authed)/dashboard/_components/WidgetConfigModal';
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
