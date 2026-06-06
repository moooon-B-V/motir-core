// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/issues/_components/issueRows';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// Inline STATUS + ASSIGNEE edits on the /issues rows (Subtask 2.5.5). The cells
// REUSE the detail page's gated Server Actions + shared pickers, so — exactly
// like issue-detail-fields.test — we stub those actions, the router, and the
// toast, then assert that opening a cell reveals the SHARED picker and a pick
// calls the SHARED action (legal-target listing itself is covered by the 2.4.4
// StatusPicker tests). Driven through the real IssueListTable so the
// IssueInlineEditProvider wiring is exercised end-to-end.
const { updateSpy, statusSpy, refreshSpy, pushSpy, toastSpy } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  statusSpy: vi.fn(),
  refreshSpy: vi.fn(),
  pushSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: statusSpy,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
  usePathname: () => '/issues',
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { IssueListTable } from '@/app/(authed)/issues/_components/IssueListTable';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

beforeAll(() => {
  (window.HTMLElement.prototype as unknown as Record<string, unknown>)['scrollIntoView'] = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_ada', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
  { userId: 'u_grace', name: 'Grace Hopper', email: 'grace@example.com', role: 'owner' },
];

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'p1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
    {
      id: 's3',
      projectId: 'p1',
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a2',
      isInitial: false,
    },
  ],
  // `open` policy → every status is a legal target, so the picker lists them all.
  transitions: [],
  policyMode: 'open',
};

function row(over: Partial<IssueRowData> & { identifier: string }): IssueRowData {
  return {
    id: `wi_${over.identifier}`,
    title: 'An issue',
    kind: 'task',
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    priority: 'medium',
    reporterName: 'Owner',
    dueLabel: null,
    estimateLabel: null,
    ...over,
  };
}

function renderTable(rows: IssueRowData[], editable = true) {
  return render(
    <IssueListTable
      rows={rows}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: rows.length, page: 1, pageSize: 50 }}
      workflow={editable ? workflow : undefined}
      members={editable ? members : undefined}
    />,
  );
}

describe('Inline row edits (Subtask 2.5.5)', () => {
  it('STATUS cell opens the shared StatusPicker and commits via changeStatusAction', () => {
    statusSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    renderTable([row({ identifier: 'PROD-1', id: 'wi_1', status: 'todo', statusLabel: 'To Do' })]);

    // The status value is a button (not just a Pill) when editable.
    const trigger = screen.getByRole('button', { name: 'Edit Status' });
    fireEvent.click(trigger);

    // autoOpen → the shared StatusPicker combobox is open with its options.
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));

    expect(statusSpy).toHaveBeenCalledWith({ id: 'wi_1', toStatusKey: 'in_progress' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('ASSIGNEE cell opens the shared AssigneePicker and reassigns via updateIssueAction (with expectedUpdatedAt)', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    renderTable([row({ identifier: 'PROD-1', id: 'wi_1', updatedAt: '2026-06-01T00:00:00.000Z' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'wi_1',
      expectedUpdatedAt: '2026-06-01T00:00:00.000Z',
      assigneeId: 'u_ada',
    });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('ASSIGNEE cell can unassign (null) via updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    renderTable([
      row({ identifier: 'PROD-1', id: 'wi_1', assigneeId: 'u_ada', assigneeName: 'Ada Lovelace' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(screen.getByRole('option', { name: 'Unassigned' }));

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', assigneeId: null }),
    );
  });

  it('opening a control reveals the picker rather than navigating the row', () => {
    renderTable([row({ identifier: 'PROD-1', id: 'wi_1' })]);

    // No picker mounted until the trigger is used (the row link is the only
    // interactive element otherwise).
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Status' }));
    // The shared picker is now open; the click opened the editor, it did not
    // follow the row's detail link.
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('renders read-only cells (no edit trigger) outside a provider', () => {
    renderTable([row({ identifier: 'PROD-1', statusLabel: 'To Do' })], false);

    expect(screen.queryByRole('button', { name: 'Edit Status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Assignee' })).toBeNull();
    // The static value is still shown.
    expect(screen.getByText('To Do')).toBeTruthy();
  });
});
