// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import { planRowDestination } from '@/lib/planning/planDestination';

const { updateSpy, changeStatusSpy, refresh } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  changeStatusSpy: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  // The held-status notice's doors address the current page (MOTIR-5528 · MOTIR-6267).
  usePathname: () => '/items/WFD-7/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: changeStatusSpy,
}));
// ParentPicker fetches candidates on mount.
vi.mock('@/app/(authed)/items/actions', () => ({
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

import { EditIssueForm } from '@/app/(authed)/items/[key]/edit/_components/EditIssueForm';

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
  difficulty: null,
  storyPoints: null,
  position: 'a0',
  sprintId: null,
  backlogRank: 'a0',
  publicChildrenHidden: false,
  sessionBranch: null,
  targetRepo: null,
  targetRepos: [],
  planningSource: null,
  planningHarness: null,
  planningModel: null,
  implementationSource: null,
  implementationHarness: null,
  implementationModel: null,
  subject: null,
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
  it('renders the editable fields, including an editable Type picker', async () => {
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

    // ParentPicker loads its candidates in an effect; flush that pass so its
    // resolution lands inside the test rather than after it.
    await act(async () => {});
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

  // ── A PLAN holds the status (Story MOTIR-6017 · MOTIR-6267) ────────────────
  const hold: PlanHoldDTO = {
    itemKey: 'WFD-7',
    workItemId: 'wi_1',
    planId: 'pln_9',
    planStatus: 'planned',
    sessionId: 'pcs_9',
    anchorKey: 'WFD-7',
  };
  const planningWorkflow: WorkflowDto = {
    ...workflow,
    statuses: [
      {
        id: 's-plan',
        projectId: 'p1',
        key: 'planning',
        label: 'Planning',
        category: 'todo',
        color: null,
        position: '0',
        isInitial: false,
      },
      ...workflow.statuses,
    ],
    policyMode: 'open',
  };

  it('a plan hold says so on the status field with Review plan, and locks every other option', async () => {
    render(
      <ToastProvider>
        <EditIssueForm
          issue={{ ...issue, status: 'planning' }}
          workflow={planningWorkflow}
          members={[]}
          planHold={hold}
        />
      </ToastProvider>,
    );
    const notice = screen.getByTestId('status-held-notice');
    expect(notice.textContent).toContain("Status can't be changed while a plan is open.");
    expect(notice.textContent).toContain('This plan is waiting for approval.');
    expect(within(notice).getByRole('link', { name: 'Review plan' }).getAttribute('href')).toBe(
      planRowDestination({
        planStatus: hold.planStatus,
        planId: hold.planId,
        sessionId: hold.sessionId,
        host: '/items/WFD-7/edit',
        anchorKey: hold.anchorKey,
      }).href,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    for (const name of ['To Do', 'In Progress']) {
      const option = screen.getByRole('option', { name: new RegExp(name) });
      expect(option.getAttribute('aria-disabled')).toBe('true');
      expect(option.textContent).toContain('held by plan');
    }
    await act(async () => {});
  });

  it('a PLAN_TARGET_HELD answer puts the status back and draws the line — no toast, no field error', async () => {
    changeStatusSpy.mockResolvedValue({
      ok: false,
      error: 'held by a plan',
      field: 'status',
      code: 'PLAN_TARGET_HELD',
      plan: { ...hold, sessionId: null },
    });
    render(
      <ToastProvider>
        <EditIssueForm issue={issue} workflow={workflow} members={[]} />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('status-held-notice')).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(changeStatusSpy).toHaveBeenCalledWith({ id: 'wi_1', toStatusKey: 'in_progress' });
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('To Do');
    const notice = screen.getByTestId('status-held-notice');
    expect(notice.textContent).toContain("Status can't be changed while a plan is open.");
    expect(within(notice).getByRole('link', { name: 'Review plan' }).getAttribute('href')).toBe(
      '/plans/pln_9',
    );
    expect(screen.queryByText('held by a plan')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
