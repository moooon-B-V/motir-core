// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkloadAssigneeDto, WorkloadDto } from '@/lib/dto/reports';

// The Workload page body over a period (Story MOTIR-8919 · MOTIR-8925): two
// segments per person bar, the neutral person-less bar last, the legend, the
// four-column data table, and the Period / Days-back controls navigating through
// `buildReportHref` with the days back clamped to the new period's ladder.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/workload',
}));
vi.mock('@/app/(authed)/reports/_components/ReportScopeCombobox', () => ({
  ReportScopeCombobox: () => <div data-testid="scope" />,
}));

const { WorkloadReport } = await import('@/app/(authed)/reports/_components/WorkloadReport');

const row = (over: Partial<WorkloadAssigneeDto>): WorkloadAssigneeDto => ({
  assigneeId: 'u1',
  name: 'Ada',
  points: 34,
  count: 9,
  assignedPoints: 21,
  assignedCount: 6,
  unassignedPoints: 13,
  unassignedCount: 3,
  ...over,
});

const data = (assignees: WorkloadAssigneeDto[]): WorkloadDto => ({
  measure: 'story_points',
  assignees,
  totalPoints: assignees.reduce((n, a) => n + a.points, 0),
  totalCount: assignees.reduce((n, a) => n + a.count, 0),
  window: { period: 'day', daysBack: 30, windowStart: '2026-09-18', windowEnd: '2026-10-18' },
});

const NOBODY = row({
  assigneeId: null,
  name: null,
  points: 4,
  count: 2,
  assignedPoints: 4,
  assignedCount: 2,
  unassignedPoints: 0,
  unassignedCount: 0,
});

const renderIt = (
  over: Partial<React.ComponentProps<typeof WorkloadReport>> = {},
  assignees = [
    row({}),
    row({ assigneeId: 'u2', name: 'Grace', points: 8, assignedPoints: 8, unassignedPoints: 0 }),
    NOBODY,
  ],
) =>
  render(
    <WorkloadReport
      result={{ state: 'ok', data: data(assignees) }}
      measure="story_points"
      period="day"
      daysBack={30}
      savedFilterId={null}
      projectName="Prodect"
      savedFilters={[]}
      {...over}
    />,
  );

beforeEach(() => push.mockClear());
afterEach(() => cleanup());

describe('WorkloadReport over a period', () => {
  it('draws a two-segment bar per person and one neutral bar for the person-less row, last', () => {
    const { container } = renderIt();
    const svg = container.querySelector('svg[role="img"]')!;
    const text = svg.textContent ?? '';
    // The split written at the bar's end; a person with nothing reported shows the total only.
    expect(text).toContain('34 = 21 + 13');
    expect(text).toContain('Grace');
    expect(text.indexOf('Unassigned')).toBeGreaterThan(text.indexOf('Grace'));
    const fills = Array.from(svg.querySelectorAll('rect[fill]')).map((r) => r.getAttribute('fill'));
    expect(fills).toContain('var(--el-chart-workload-assigned)');
    expect(fills).toContain('var(--el-chart-workload-unassigned)');
    expect(fills).toContain('var(--el-chart-cat-none)');
  });

  it('names both segments in the legend', () => {
    renderIt();
    expect(screen.getAllByText('Assigned').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unassigned — reported by').length).toBeGreaterThan(0);
  });

  it('the data table has person · assigned · unassigned · total, for the active measure', () => {
    renderIt({ measure: 'issue_count' });
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Assignee', 'Assigned', 'Unassigned (reported)', 'Total']);
    const ada = within(table).getByText('Ada').closest('tr')!;
    expect(
      within(ada)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['6', '3', '9']);
  });

  it('an empty window shows the empty state', () => {
    renderIt({}, []);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No data in this window')).toBeTruthy();
  });

  it('a Period change navigates with days back clamped to the new ladder', () => {
    renderIt({ daysBack: 365, period: 'month' });
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    // 365 is over the daily cap, so it snaps to the largest valid rung.
    const href = push.mock.calls[0]![0] as string;
    expect(href).toMatch(/^\/reports\/workload\?/);
    expect(href).toContain('daysBack=');
    expect(href).not.toContain('daysBack=365');
    expect(href).not.toContain('period=');
  });

  it('Days back steps along the ladder and keeps the measure', () => {
    renderIt({ measure: 'issue_count' });
    fireEvent.click(screen.getByRole('button', { name: 'Longer window' }));
    expect(push).toHaveBeenCalledWith('/reports/workload?daysBack=60&measure=issue_count');
  });
});
