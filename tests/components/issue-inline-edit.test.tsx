// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// Inline STATUS + ASSIGNEE edits on the /items rows (Subtask 2.5.5). The cells
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
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: statusSpy,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

beforeAll(() => {
  // Radix Popover (the DatePicker dialog) needs a few browser APIs happy-dom lacks.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['scrollIntoView'] = vi.fn();
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
    type: null,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    priority: 'medium',
    reporterName: 'Owner',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    storyPoints: null,
    estimateLabel: null,
    storyPointsLabel: null,
    hasChildren: false,
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

  it('PRIORITY cell opens the shared PriorityPicker and commits via updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    renderTable([row({ identifier: 'PROD-1', id: 'wi_1', priority: 'medium' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));

    expect(updateSpy).toHaveBeenCalledWith({
      id: 'wi_1',
      expectedUpdatedAt: '2026-06-01T00:00:00.000Z',
      priority: 'high',
    });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('ESTIMATE cell commits a new value on blur via updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    renderTable([row({ identifier: 'PROD-1', id: 'wi_1', estimateMinutes: null })]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Estimate' }));
    const input = screen.getByLabelText('Estimate (minutes)');
    fireEvent.change(input, { target: { value: '120' } });
    expect(updateSpy).not.toHaveBeenCalled(); // not per-keystroke
    fireEvent.blur(input);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', estimateMinutes: 120 }),
    );
  });

  // (The "DUE cell opens the calendar picker" test was removed with the Due
  // column — Due is no longer a list/tree column, MOTIR-1307. Inline date editing
  // still lives on the detail page's core-fields rail, covered by its own tests.)

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

describe('read-only inline cells (Story 6.4.6)', () => {
  function renderGated(canEdit: boolean) {
    return render(
      <ProjectAccessProvider canEdit={canEdit}>
        <IssueListTable
          rows={[row({ identifier: 'PROD-1', id: 'wi_1', status: 'todo', statusLabel: 'To Do' })]}
          sort={{ column: 'key', direction: 'asc' }}
          filter={EMPTY_FILTER}
          pagination={{ total: 1, page: 1, pageSize: 50 }}
          workflow={workflow}
          members={members}
        />
      </ProjectAccessProvider>,
    );
  }

  it('renders every inline cell read-only (no edit triggers) when the actor cannot edit', () => {
    renderGated(false);
    expect(screen.queryByRole('button', { name: 'Edit Status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Assignee' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Priority' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Estimate' })).toBeNull();
    // the read-only status value is still shown.
    expect(screen.getAllByText('To Do').length).toBeGreaterThan(0);
  });

  it('stays editable when the actor can edit (the provider default path)', () => {
    renderGated(true);
    expect(screen.getByRole('button', { name: 'Edit Status' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Assignee' })).toBeTruthy();
  });
});
