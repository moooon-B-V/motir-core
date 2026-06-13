// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { SprintReport } from '@/app/(authed)/backlog/_components/SprintReport';
import type { StatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import type { SprintDto, SprintReportDto } from '@/lib/dto/sprints';
import type { BurndownSeriesDto, VelocityDto } from '@/lib/dto/reports';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';

// Sprint report surface (Story 4.4 · Subtask 4.4.6). The presentational report
// (design/sprints/sprint-lifecycle.mock.html panels 6–7) used by BOTH the
// complete-modal success state and the standalone /sprints/[id]/report page. Pure
// component — assert the points rollup, the scope-change line, the completed /
// not-completed lists (bounded + a "View all in Work Items" deep-link), the unestimated
// "—" presentation, the carry-over "→ destination" chip, and the Story-4.6 analytics
// charts (4.6.5 burndown + 4.6.6 velocity) — against the real English catalog via
// renderWithIntl. The deep burndown/velocity coverage is Subtask 4.6.7's; these are
// the surface smoke checks.

afterEach(cleanup);

const statusByKey: StatusByKey = new Map([
  ['done', { label: 'Done', category: 'done' }],
  ['in_progress', { label: 'In progress', category: 'in_progress' }],
  ['todo', { label: 'To do', category: 'todo' }],
]);

function issue(over: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi1',
    parentId: null,
    kind: 'story',
    key: 241,
    identifier: 'PROD-241',
    title: 'Sprint start flow',
    status: 'done',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: 5,
    archivedAt: null,
    ...over,
  };
}

function page(items: WorkItemSummaryDto[], totalCount = items.length): RankedIssuePageDto {
  return { items, nextCursor: null, totalCount };
}

function sprint(over: Partial<SprintDto> = {}): SprintDto {
  return {
    id: 'sp6',
    name: 'Sprint 6',
    goal: 'Ship the sprint lifecycle',
    state: 'complete',
    startDate: '2026-06-09T00:00:00.000Z',
    endDate: '2026-06-22T00:00:00.000Z',
    completedAt: '2026-06-22T00:00:00.000Z',
    sequence: 6,
    issueCount: 18,
    committedPoints: 42,
    committedIssueCount: 18,
    ...over,
  };
}

function report(over: Partial<SprintReportDto> = {}): SprintReportDto {
  return {
    sprintId: 'sp6',
    state: 'complete',
    points: { committed: 42, completed: 29, notCompleted: 13 },
    completed: page([
      issue({
        id: 'c1',
        identifier: 'PROD-241',
        title: 'Start flow',
        status: 'done',
        storyPoints: 5,
      }),
    ]),
    incomplete: page([
      issue({
        id: 'i1',
        kind: 'task',
        identifier: 'PROD-244',
        title: 'Report data',
        status: 'in_progress',
        storyPoints: 3,
      }),
    ]),
    addedAfterStart: 2,
    ...over,
  };
}

describe('SprintReport (4.4.6)', () => {
  it('renders the points rollup, scope-change line, lists, and the burndown slot', () => {
    render(<SprintReport report={report()} sprint={sprint()} statusByKey={statusByKey} />);

    // 3-up points: committed 42 / completed 29 / not-completed 13.
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByText('13')).toBeTruthy();
    // Scope change ("2 work items added after the sprint started").
    expect(screen.getByText(/2 work items added after the sprint started/)).toBeTruthy();
    // Both lists render their rows with the work-items row vocabulary.
    expect(screen.getByTestId('report-row-PROD-241')).toBeTruthy();
    expect(screen.getByTestId('report-row-PROD-244')).toBeTruthy();
    // Bounded — each section deep-links to the /issues navigator filtered to the sprint.
    const viewAll = screen.getAllByRole('link', { name: /View all in Work Items/ });
    expect(viewAll.length).toBe(2);
    expect(viewAll[0]!.getAttribute('href')).toBe('/issues?sprint=sp6');
    // The Story-4.6 burndown section (4.6.5): with no server-fed series, the
    // slot client-fetches and shows the loading skeleton first.
    expect(screen.getByText('Burndown')).toBeTruthy();
    expect(screen.getByRole('status', { name: /Loading the burndown chart/ })).toBeTruthy();
  });

  it('renders "—" for every point figure when the sprint was started unestimated', () => {
    render(
      <SprintReport
        report={report({
          points: { committed: null, completed: 0, notCompleted: 0 },
          completed: page([issue({ storyPoints: null })]),
          incomplete: page([]),
        })}
        sprint={sprint({ committedPoints: null })}
        statusByKey={statusByKey}
      />,
    );
    // All three point stats + the row point cell render the dash, never NaN.
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('shows the carry-over "→ destination" chip on incomplete rows when a label is passed', () => {
    render(
      <SprintReport
        report={report()}
        sprint={sprint()}
        statusByKey={statusByKey}
        carryOverLabel="Backlog"
      />,
    );
    const incompleteRow = screen.getByTestId('report-row-PROD-244');
    expect(within(incompleteRow).getByText('Backlog')).toBeTruthy();
  });

  it('renders an empty-state line for a section with no issues', () => {
    render(
      <SprintReport
        report={report({ incomplete: page([]) })}
        sprint={sprint()}
        statusByKey={statusByKey}
      />,
    );
    expect(screen.getByText('No incomplete work items.')).toBeTruthy();
  });
});

// The velocity chart in the report's analytics row (Story 4.6 · Subtask 4.6.6) —
// the 4.6.2 BarChart bound to the 4.6.4 `getVelocity` read, mounted beside the
// burndown seam per design/reports/charts.mock.html panels 3 + 5. Series read as
// text+number (legend, value labels, data table — finding #35); low history
// (0–1 completed sprints) is the "not enough history yet" state, never an
// axis-of-one; the modal (no `velocity` prop) shows no velocity section.

function velocity(over: Partial<VelocityDto> = {}): VelocityDto {
  return {
    sprints: [
      { sprintId: 's1', name: 'Sprint 4', committed: 30, completed: 24 },
      { sprintId: 's2', name: 'Sprint 5', committed: 28, completed: 30 },
      { sprintId: 's3', name: 'Sprint 6', committed: 42, completed: 29 },
    ],
    averageCompleted: 27.666666,
    statistic: 'story_points',
    ...over,
  };
}

describe('SprintReport velocity (4.6.6)', () => {
  it('renders the velocity chart — legend, sprint categories, average, and the data-table fallback', () => {
    render(
      <SprintReport
        report={report()}
        sprint={sprint()}
        statusByKey={statusByKey}
        velocity={velocity()}
      />,
    );

    // The section heading + the window/average sub-line (read as text).
    expect(screen.getByText('Velocity')).toBeTruthy();
    expect(screen.getByText(/Last 3 completed sprints/)).toBeTruthy();
    expect(screen.getByText(/avg completed 27\.7/)).toBeTruthy();
    // The TEXT legend distinguishes the bars (finding #35) — committed /
    // completed / the dashed average reference.
    expect(screen.getAllByText('Committed').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Average completed')).toBeTruthy();
    // Sprint categories — the X-axis tick AND the data-table row header.
    expect(screen.getAllByText('Sprint 4').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Sprint 5').length).toBeGreaterThanOrEqual(2);
    // The data-table fallback re-expresses every series as numbers.
    expect(screen.getByText(/committed vs completed story points per sprint/i)).toBeTruthy();
    const table = screen.getByRole('table');
    const row = within(table).getByText('Sprint 4').closest('tr')!;
    expect(within(row).getByText('30')).toBeTruthy();
    expect(within(row).getByText('24')).toBeTruthy();
    expect(screen.queryByText('NaN')).toBeNull();
  });

  it('renders the low-history state (not an axis-of-one) for 0–1 completed sprints', () => {
    render(
      <SprintReport
        report={report()}
        sprint={sprint()}
        statusByKey={statusByKey}
        velocity={velocity({
          sprints: [{ sprintId: 's1', name: 'Sprint 6', committed: 42, completed: 29 }],
          averageCompleted: 29,
        })}
      />,
    );
    expect(screen.getByText('Not enough history yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders no velocity section when the host passes no velocity (the complete modal)', () => {
    render(<SprintReport report={report()} sprint={sprint()} statusByKey={statusByKey} />);
    expect(screen.queryByText('Velocity')).toBeNull();
    // The burndown section is still there (the modal slot self-fetches).
    expect(screen.getByText('Burndown')).toBeTruthy();
  });
});

// The burndown chart in the report's analytics row (Story 4.6 · Subtask 4.6.5) —
// the 4.6.2 LineChart bound to the 4.6.3 `getBurndownSeries` read, filling the
// seam 4.4.6 reserved per design/reports/charts.mock.html panels 1 + 5. The
// full form: dashed guideline + stepped actual, the committed-baseline and
// end-point annotations, the scope-change diamond, and the data-table fallback
// (finding #35). Deep state coverage (unestimated / empty / active) is 4.6.7's.

function burndown(over: Partial<BurndownSeriesDto> = {}): BurndownSeriesDto {
  return {
    sprintId: 'sp6',
    state: 'complete',
    statistic: 'story_points',
    committed: 40,
    startDate: '2026-06-09T00:00:00.000Z',
    endDate: '2026-06-13T00:00:00.000Z',
    days: [
      { date: '2026-06-09', guideline: 40, remaining: 40 },
      { date: '2026-06-10', guideline: 30, remaining: 32 },
      { date: '2026-06-11', guideline: 20, remaining: 36 },
      { date: '2026-06-12', guideline: 10, remaining: 24 },
      { date: '2026-06-13', guideline: 0, remaining: 12 },
    ],
    scopeChanges: [{ date: '2026-06-11', delta: 4 }],
    ...over,
  };
}

describe('SprintReport burndown (4.6.5)', () => {
  it('renders the completed-sprint burndown — legend, annotations, and the data-table fallback', () => {
    render(
      <SprintReport
        report={report()}
        sprint={sprint()}
        statusByKey={statusByKey}
        burndown={burndown()}
      />,
    );

    // The TEXT legend names every series (finding #35) — the guideline, the
    // actual remaining, and the scope marker.
    // (each appears in the legend AND as a data-table column header)
    expect(screen.getAllByText('Guideline').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Remaining').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Scope added')).toBeTruthy();
    // The committed baseline + end-point annotations and the scope label.
    expect(screen.getByText('40 committed')).toBeTruthy();
    expect(screen.getByText('12 left')).toBeTruthy();
    expect(screen.getByText('+4 scope')).toBeTruthy();
    // The data-table fallback re-expresses the series as numbers, with the
    // start + scope-change events.
    expect(screen.getByText(/story points remaining by day/i)).toBeTruthy();
    const tables = screen.getAllByRole('table');
    const burndownTable = tables.find((el) =>
      within(el).queryByText(/Sprint started · 40 committed/),
    )!;
    expect(burndownTable).toBeTruthy();
    expect(within(burndownTable).getByText('+4 scope change')).toBeTruthy();
    expect(within(burndownTable).getByText('Sprint completed')).toBeTruthy();
    expect(screen.queryByText('NaN')).toBeNull();
    // Server-fed: no client fetch, so no loading skeleton.
    expect(screen.queryByRole('status', { name: /Loading the burndown chart/ })).toBeNull();
  });
});
