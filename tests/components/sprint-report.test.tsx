// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { SprintReport } from '@/app/(authed)/backlog/_components/SprintReport';
import type { StatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import type { SprintDto, SprintReportDto } from '@/lib/dto/sprints';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';

// Sprint report surface (Story 4.4 · Subtask 4.4.6). The presentational report
// (design/sprints/sprint-lifecycle.mock.html panels 6–7) used by BOTH the
// complete-modal success state and the standalone /sprints/[id]/report page. Pure
// component — assert the points rollup, the scope-change line, the completed /
// not-completed lists (bounded + a "View all in Issues" deep-link), the unestimated
// "—" presentation, the carry-over "→ destination" chip, and the Story-4.6 chart
// seam — against the real English catalog via renderWithIntl.

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
  it('renders the points rollup, scope-change line, lists, and the chart seam', () => {
    render(<SprintReport report={report()} sprint={sprint()} statusByKey={statusByKey} />);

    // 3-up points: committed 42 / completed 29 / not-completed 13.
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByText('13')).toBeTruthy();
    // Scope change ("2 issues added after the sprint started").
    expect(screen.getByText(/2 issues added after the sprint started/)).toBeTruthy();
    // Both lists render their rows with the work-items row vocabulary.
    expect(screen.getByTestId('report-row-PROD-241')).toBeTruthy();
    expect(screen.getByTestId('report-row-PROD-244')).toBeTruthy();
    // Bounded — each section deep-links to the /issues navigator filtered to the sprint.
    const viewAll = screen.getAllByRole('link', { name: /View all in Issues/ });
    expect(viewAll.length).toBe(2);
    expect(viewAll[0].getAttribute('href')).toBe('/issues?sprint=sp6');
    // The Story-4.6 burndown chart SEAM (no chart here).
    expect(screen.getByText('Burndown')).toBeTruthy();
    expect(screen.getByText('Story 4.6')).toBeTruthy();
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
    expect(screen.getByText('No incomplete issues.')).toBeTruthy();
  });
});
