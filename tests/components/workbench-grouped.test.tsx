// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import enMessages from '@/messages/en.json';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// THE GROUPED WORK TABS (Story MOTIR-8012 · MOTIR-8016; `design/workbench/design-notes.md`
// § 36) under happy-dom. To do, In progress and Recently finished draw the service's
// groups: a group row with its chevron and count, members one level in, the context head,
// standalone rows. The service's grouping is covered against real Postgres in
// `tests/integration/workbench/grouping-service.test.ts`; this covers what only the
// RENDER can get wrong.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';
import { INDENT_PX } from '@/components/ui/TreeTable';
import type { WorkbenchTab } from '@/lib/workbench/tab';

/** `homeService`'s `HOME_PAGE_SIZE` — restated, since that module is server-only. */
const HOME_PAGE_SIZE = 25;

const EMPTY = <p>Nothing is waiting</p>;

afterEach(() => {
  cleanup();
  push.mockReset();
});

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u1',
    name: 'Zhu Yue',
    email: 'yue@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
  {
    userId: 'u2',
    name: 'Mei Lin',
    email: 'mei@example.com',
    workspaceRole: 'member',
    customRole: null,
  },
];

const WORKFLOW = {
  statuses: [
    { key: 'todo', label: 'To Do', category: 'todo' },
    { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    { key: 'done', label: 'Done', category: 'done' },
  ],
} as unknown as WorkflowDto;

function dto(over: Partial<HomeWorkItemRowDto> & { identifier: string }): HomeWorkItemRowDto {
  return {
    id: `wi_${over.identifier}`,
    kind: 'subtask',
    type: null,
    key: 1,
    title: `Title of ${over.identifier}`,
    status: 'in_progress',
    ciState: null,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-10-09T00:00:00.000Z',
    completedAt: null,
    fixReason: null,
    fixDetail: null,
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: false,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: null,
    resumeRunId: null,
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: false,
    repairRun: null,
    ...over,
  };
}

/** A story the reader does not hold, heading the given members — a CONTEXT head. */
const contextHead = (identifier: string, members: HomeWorkItemRowDto[]) =>
  dto({
    identifier,
    kind: 'story',
    status: 'todo',
    assigneeId: 'u2',
    reporterId: 'u2',
    viewerIsAssignee: false,
    viewerIsReporter: false,
    ciState: 'failing',
    groupHead: 'context',
    groupMembers: members,
  });

const S = () =>
  contextHead('S-1', [
    dto({ identifier: 'S-2', ciState: 'failing' }),
    dto({ identifier: 'S-3' }),
    dto({ identifier: 'S-4' }),
  ]);
const T = () => contextHead('T-1', [dto({ identifier: 'T-2' })]);

function list(
  rows: HomeWorkItemRowDto[],
  tab: WorkbenchTab = 'in-progress',
  pagination = { total: rows.length, page: 1, pageSize: HOME_PAGE_SIZE },
) {
  return (
    <WorkbenchList
      rows={toWorkbenchRowViews(rows, WORKFLOW, MEMBERS, false)}
      label="In progress"
      tab={tab}
      pagination={pagination}
      empty={EMPTY}
    />
  );
}

const group = (key: string) => screen.getByTestId(`workbench-group-${key}`);
const toggle = (key: string) => screen.getByTestId(`workbench-group-toggle-${key}`);
const rowOf = (key: string) => screen.queryByTestId(`workbench-row-${key}`);

describe('In progress, grouped (§ 36.3)', () => {
  it('draws S (3) and T (1) shut, and S’s members once its chevron opens', () => {
    render(list([S(), T()]));

    expect(within(group('S-1')).getByTestId('workbench-group-count').textContent).toBe('3');
    expect(within(group('T-1')).getByTestId('workbench-group-count').textContent).toBe('1');
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('S-1').getAttribute('aria-label')).toBe('Expand S-1');
    expect(toggle('T-1').getAttribute('aria-expanded')).toBe('false');
    for (const key of ['S-2', 'S-3', 'S-4', 'T-2']) expect(rowOf(key)).toBeNull();

    fireEvent.click(toggle('S-1'));

    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('S-1').getAttribute('aria-label')).toBe('Collapse S-1');
    const members = within(screen.getByTestId('workbench-group-members-S-1'))
      .getAllByRole('row')
      .slice(1);
    expect(members.map((r) => r.getAttribute('data-testid'))).toEqual([
      'workbench-row-S-2',
      'workbench-row-S-3',
      'workbench-row-S-4',
    ]);
    // Each member is the shipped row, indented one tree level, CI glyph included.
    for (const member of members) {
      const name = member.querySelector('[role="cell"] > span') as HTMLElement;
      expect(name.style.marginLeft).toBe(`${INDENT_PX}px`);
    }
    expect(rowOf('S-2')!.querySelector('[data-ci-state]')).not.toBeNull();
    expect(rowOf('T-2')).toBeNull();
  });

  it('names the group’s rowgroup and points the chevron at it', () => {
    render(list([S(), T()]));
    const rowgroup = screen.getByRole('rowgroup', { name: 'Work items under S-1' });
    expect(toggle('S-1').getAttribute('aria-controls')).toBe(rowgroup.id);
    expect(within(group('S-1')).getByLabelText('3 work items on this tab')).toBeTruthy();
  });

  it('opens the one group on a page that holds exactly one', () => {
    render(list([S(), dto({ identifier: 'L-1', kind: 'task' })]));
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('S-2')).not.toBeNull();
  });

  it('carries no run control on a group row', () => {
    render(list([S(), T()]));
    const buttons = within(group('S-1')).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'workbench-group-toggle-S-1',
    ]);
  });
});

describe('the context head (§ 36.2)', () => {
  it('reads Not on this tab, drops the assignee and CI glyph, and keeps its status', () => {
    render(list([S(), T()]));
    const head = group('S-1');
    expect(head.getAttribute('data-group-head')).toBe('context');
    expect(within(head).getByText('Not on this tab')).toBeTruthy();
    expect(within(head).queryByText('Assigned')).toBeNull();
    expect(within(head).queryByText('Mei Lin')).toBeNull();
    expect(head.querySelector('[data-ci-state]')).toBeNull();
    expect(within(head).getByText('To Do')).toBeTruthy();
  });

  it('carries no Finished value on Recently finished', () => {
    const finished = (identifier: string) =>
      dto({ identifier, status: 'done', completedAt: new Date().toISOString() });
    const head = contextHead('S-1', [finished('S-2')]);
    head.completedAt = new Date().toISOString();
    render(list([head, T()], 'finished'));
    const cells = within(group('S-1')).getAllByRole('cell');
    expect(cells).toHaveLength(5);
    expect(cells[4]!.textContent).toBe('');
  });
});

describe('the member head and standalone rows', () => {
  it('draws a member head ONCE, as the group row, with its full cells', () => {
    const head = dto({
      identifier: 'S-1',
      kind: 'story',
      groupHead: 'member',
      ciState: 'failing',
      groupMembers: [dto({ identifier: 'S-2' })],
    });
    render(list([head, T()]));
    expect(group('S-1').getAttribute('data-group-head')).toBe('member');
    expect(within(group('S-1')).getByText('Assigned')).toBeTruthy();
    expect(group('S-1').querySelector('[data-ci-state]')).not.toBeNull();
    fireEvent.click(toggle('S-1'));
    expect(screen.getAllByText('S-1')).toHaveLength(1);
    expect(rowOf('S-1')).toBeNull();
  });

  it('draws a standalone row as today’s row, with the 16px slot reserved', () => {
    render(list([dto({ identifier: 'L-1', kind: 'task' }), S(), T()], 'todo'));
    const row = rowOf('L-1')!;
    const slot = row.querySelector('[data-group-slot]');
    expect(slot?.className).toContain('w-4');
    expect(row.querySelector('button')).toBeNull();
  });

  it('keeps the service’s order on Recently finished, with no client sort', () => {
    const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const head = contextHead('S-1', [
      dto({ identifier: 'S-3', status: 'done', completedAt: at(1) }),
      dto({ identifier: 'S-2', status: 'done', completedAt: at(2) }),
    ]);
    render(
      list(
        [dto({ identifier: 'L-9', kind: 'task', status: 'done', completedAt: at(0) }), head],
        'finished',
      ),
    );
    const order = screen
      .getAllByRole('row')
      .map((r) => r.getAttribute('data-testid'))
      .filter(Boolean);
    expect(order).toEqual([
      'workbench-row-L-9',
      'workbench-group-S-1',
      'workbench-row-S-3',
      'workbench-row-S-2',
    ]);
    expect(within(rowOf('S-3')!).getByText('yesterday')).toBeTruthy();
  });
});

describe('live (§ 36.7, § 26 unchanged)', () => {
  it('marks a member that arrives in an open group, and keeps one that leaves in place', () => {
    const view = render(list([S()]));
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('true');

    const next = S();
    next.groupMembers = [next.groupMembers[0]!, next.groupMembers[2]!, dto({ identifier: 'S-5' })];
    view.rerender(list([next]));

    expect(within(rowOf('S-5')!).getByText('New')).toBeTruthy();
    // S-3 left: held in place, unmarked, until the next load — the work tabs' rule.
    expect(rowOf('S-3')).not.toBeNull();
    expect(within(rowOf('S-3')!).queryByText('Cleared')).toBeNull();
    // The count is the server's, at once.
    expect(within(group('S-1')).getByTestId('workbench-group-count').textContent).toBe('3');
    // The group stayed open through the update.
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('true');
  });

  it('puts New on a SHUT group row when a member arrives inside it', () => {
    const view = render(list([S(), T()]));
    const next = T();
    next.groupMembers = [...next.groupMembers, dto({ identifier: 'T-3' })];
    view.rerender(list([S(), next]));
    expect(within(group('T-1')).getByText('New')).toBeTruthy();
    expect(within(group('T-1')).getByTestId('workbench-group-count').textContent).toBe('2');
    expect(within(group('S-1')).queryByText('New')).toBeNull();
  });

  it('resets the expand state on a pager move', () => {
    const view = render(list([S(), T()], 'in-progress', { total: 30, page: 1, pageSize: 25 }));
    fireEvent.click(toggle('S-1'));
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('true');
    view.rerender(list([S(), T()], 'in-progress', { total: 30, page: 2, pageSize: 25 }));
    expect(toggle('S-1').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the pager over groups (§ 36.6)', () => {
  it('pages the group total and pushes the tab’s own address', () => {
    render(list([S(), T()], 'in-progress', { total: 30, page: 1, pageSize: HOME_PAGE_SIZE }));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1–25 of 30');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(push).toHaveBeenCalledWith('/workbench?tab=in-progress&page=2');
  });
});

describe('zh', () => {
  it('renders the count, the chevron names, the context marker and the rowgroup name', () => {
    render(list([S(), T()]), { locale: 'zh', messages: zhMessages });
    expect(toggle('S-1').getAttribute('aria-label')).toBe('展开 S-1');
    expect(within(group('S-1')).getByText('不在此标签页')).toBeTruthy();
    expect(within(group('S-1')).getByLabelText('此标签页中有 3 个工作项')).toBeTruthy();
    expect(screen.getByRole('rowgroup', { name: 'S-1 下的工作项' })).toBeTruthy();
    fireEvent.click(toggle('S-1'));
    expect(toggle('S-1').getAttribute('aria-label')).toBe('收起 S-1');
  });

  it('has every workbench.group key in both catalogues', () => {
    expect(Object.keys(zhMessages.workbench.group).sort()).toEqual(
      Object.keys(enMessages.workbench.group).sort(),
    );
  });
});

describe('the other tabs are untouched', () => {
  it('draws Watching and To fix rows with no chevron and no slot', () => {
    for (const tab of ['watching', 'to-fix'] as const) {
      render(list([dto({ identifier: 'W-1', kind: 'task' })], tab));
      const row = rowOf('W-1')!;
      expect(row.querySelector('button')).toBeNull();
      expect(row.querySelector('[data-group-slot]')).toBeNull();
      cleanup();
    }
  });
});
