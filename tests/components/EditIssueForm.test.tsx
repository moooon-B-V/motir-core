// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';

const { updateSpy, changeStatusSpy, refresh } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  changeStatusSpy: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: changeStatusSpy,
}));
// ParentPicker fetches candidates on mount.
vi.mock('@/app/(authed)/issues/actions', () => ({
  listCandidateParentsAction: vi.fn(async () => ({ ok: true, candidates: [] })),
}));
// The MarkdownEditor/View are client-only (Tiptap WYSIWYG) — stub them.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Description" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('@/components/ui/MarkdownView', () => ({
  MarkdownView: ({ value }: { value: string }) => <div>{value}</div>,
}));

import { EditIssueForm } from '@/app/(authed)/issues/[key]/edit/_components/EditIssueForm';

const issue: WorkItemDto = {
  id: 'wi_1',
  projectId: 'p1',
  parentId: null,
  kind: 'task',
  key: 7,
  identifier: 'WFD-7',
  title: 'Original title',
  descriptionMd: null,
  explanationMd: null,
  explanationSource: 'user_authored',
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  reporterId: 'u1',
  dueDate: null,
  estimateMinutes: null,
  type: null,
  executor: null,
  storyPoints: null,
  position: 'a0',
  sprintId: null,
  backlogRank: 'a0',
  publicChildrenHidden: false,
  sessionBranch: null,
  archivedAt: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's-todo',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a',
      isInitial: true,
    },
    {
      id: 's-prog',
      projectId: 'p1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'b',
      isInitial: false,
    },
  ],
  transitions: [{ id: 't1', projectId: 'p1', fromStatusId: 's-todo', toStatusId: 's-prog' }],
  policyMode: 'restricted',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditIssueForm', () => {
  it('renders the editable fields, including an editable Type picker', () => {
    render(
      <ToastProvider>
        <EditIssueForm issue={issue} workflow={workflow} members={[]} />
      </ToastProvider>,
    );
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Original title');
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Parent' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeTruthy();
    // Type is now editable (kind is mutable; a change re-validates parent/children).
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeTruthy();
  });

  it('changing the Type submits the new kind via updateWorkItem', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });

    render(
      <ToastProvider>
        <EditIssueForm issue={issue} workflow={workflow} members={[]} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Story' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({ id: 'wi_1', kind: 'story' });
    expect(changeStatusSpy).not.toHaveBeenCalled();
  });

  it('a mixed edit (title + status) submits via BOTH server actions', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:00:00.000Z' });
    changeStatusSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-02T00:01:00.000Z' });

    render(
      <ToastProvider>
        <EditIssueForm issue={issue} workflow={workflow} members={[]} />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      id: 'wi_1',
      title: 'New title',
      expectedUpdatedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(changeStatusSpy).toHaveBeenCalledTimes(1);
    expect(changeStatusSpy.mock.calls[0]![0]).toEqual({ id: 'wi_1', toStatusKey: 'in_progress' });
    expect(refresh).toHaveBeenCalled();
  });

  it('a stale 409 from the non-status save shows the refresh banner and skips the status call', async () => {
    updateSpy.mockResolvedValue({ ok: false, error: 'stale', stale: true });

    render(
      <ToastProvider>
        <EditIssueForm issue={issue} workflow={workflow} members={[]} />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(screen.getByText(/edited by someone else/i)).toBeTruthy();
    expect(changeStatusSpy).not.toHaveBeenCalled(); // bailed before the status call
  });
});
