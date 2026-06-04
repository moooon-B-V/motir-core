// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The inline rail commits through the edit Server Actions + refreshes the route;
// stub those, the parent-candidates fetch, the router, and the toast so the
// panel drives in isolation.
const { updateSpy, statusSpy, refreshSpy, toastSpy } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  statusSpy: vi.fn(),
  refreshSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: statusSpy,
}));
vi.mock('@/app/(authed)/issues/actions', () => ({
  listCandidateParentsAction: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { CoreFieldsPanel } from '@/app/(authed)/issues/[key]/_components/CoreFieldsPanel';
import { IssueExplanation } from '@/app/(authed)/issues/[key]/_components/IssueExplanation';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_assignee', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
  { userId: 'u_reporter', name: 'Grace Hopper', email: 'grace@example.com', role: 'owner' },
];

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'proj_1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'proj_1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
    {
      id: 's3',
      projectId: 'proj_1',
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a2',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

// A fully-populated work item; per-test overrides exercise the empty states.
function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'proj_1',
    parentId: null,
    kind: 'story',
    key: 7,
    identifier: 'PROD-7',
    title: 'Ship the detail page',
    descriptionMd: '# Hello',
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
    priority: 'high',
    assigneeId: 'u_assignee',
    reporterId: 'u_reporter',
    dueDate: '2026-06-10T00:00:00.000Z',
    estimateMinutes: 90,
    position: 'a0',
    archivedAt: null,
    createdAt: '2026-06-01T14:45:00.000Z',
    updatedAt: '2026-06-03T09:30:00.000Z',
    ...overrides,
  };
}

function renderPanel(item = makeItem()) {
  return render(
    <CoreFieldsPanel item={item} members={members} workflow={workflow} reporterIsSelf />,
  );
}

describe('CoreFieldsPanel (inline rail)', () => {
  it('renders the read-only fields + the current values of the editable controls', () => {
    renderPanel();

    // Read-only: type, reporter, created/updated (deterministic en-US/UTC).
    expect(screen.getByText('Story')).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Jun 1, 02:45 PM UTC')).toBeTruthy();
    expect(screen.getByText('Jun 3, 09:30 AM UTC')).toBeTruthy();

    // Editable: priority select reflects the current value; due/estimate inputs
    // are seeded; the status + assignee pickers render.
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('high');
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-06-10');
    expect((screen.getByLabelText('Estimate (minutes)') as HTMLInputElement).value).toBe('90');
    expect(screen.getByRole('combobox', { name: /status/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /assignee/i })).toBeTruthy();
  });

  it('commits a priority change through updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'low' } });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', priority: 'low' }),
    );
  });

  it('commits an estimate edit on blur (and not on every keystroke)', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    const estimate = screen.getByLabelText('Estimate (minutes)');
    fireEvent.change(estimate, { target: { value: '120' } });
    expect(updateSpy).not.toHaveBeenCalled(); // no per-keystroke patch
    fireEvent.blur(estimate);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ estimateMinutes: 120 }));
  });
});

const EDIT_HREF = '/issues/PROD-7/edit';

describe('IssueExplanation', () => {
  it('renders the AI-drafted badge for an ai_draft explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Because it matters."
        explanationSource="ai_draft"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.getByText('AI-drafted')).toBeTruthy();
    expect(screen.getByText('Because it matters.')).toBeTruthy();
  });

  it('omits the badge for a user_authored explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Human-written rationale."
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.getByText('Human-written rationale.')).toBeTruthy();
  });

  it('shows the always-present section with an empty state when there is no explanation', () => {
    render(
      <IssueExplanation
        explanationMd={null}
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    // The section header is always present; the body is the empty state.
    expect(screen.getByRole('heading', { name: 'Explanation' })).toBeTruthy();
    expect(screen.getByText('No explanation yet.')).toBeTruthy();
  });
});
