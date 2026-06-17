// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';

// The inline rail commits through the edit Server Actions + refreshes the route;
// stub those, the parent-candidates fetch, the router, and the toast so the
// panel drives in isolation.
const { updateSpy, statusSpy, refreshSpy, toastSpy, setSprintSpy } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  statusSpy: vi.fn(),
  refreshSpy: vi.fn(),
  toastSpy: vi.fn(),
  setSprintSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: statusSpy,
}));
// The Sprint field commits through the assign route via this client helper
// (2.4.14) — stub the fetch so the panel drives in isolation.
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  setWorkItemSprint: setSprintSpy,
}));
vi.mock('@/app/(authed)/issues/actions', () => ({
  listCandidateParentsAction: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
}));
// CoreFieldsPanel composes CustomFieldsSection (5.3.7), whose Server Action
// would pull the real db module into this unit suite — stub it out (its own
// behaviour is covered by custom-fields-section.test.tsx).
vi.mock('@/app/(authed)/issues/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn().mockResolvedValue({ ok: true }),
}));
// Same for the Labels/Components cards' actions (5.4.8) — the panel imports
// the cards statically even when the optional `labelsComponents` prop is
// absent (their behaviour is covered by labels-components-cards.test.tsx).
vi.mock('@/app/(authed)/issues/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  removeLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  addComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
  removeComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
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
    type: null,
    executor: null,
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    archivedAt: null,
    createdAt: '2026-06-01T14:45:00.000Z',
    updatedAt: '2026-06-03T09:30:00.000Z',
    ...overrides,
  };
}

function renderPanel(item = makeItem()) {
  return render(
    <CoreFieldsPanel
      item={item}
      members={members}
      workflow={workflow}
      parent={null}
      reporterIsSelf
    />,
  );
}

describe('CoreFieldsPanel (inline rail)', () => {
  it('DISPLAYS each field value (controls are hidden until the chevron is clicked)', () => {
    renderPanel();

    // Displayed values: status pill (To Do), type, priority pill (High),
    // reporter, due date, estimate, created/updated.
    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByText('Story')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Jun 10, 2026')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();
    expect(screen.getByText('Jun 1, 02:45 PM UTC')).toBeTruthy();

    // No edit control is mounted until its chevron is used.
    expect(screen.queryByLabelText('Priority')).toBeNull();
    expect(screen.queryByLabelText('Estimate (minutes)')).toBeNull();

    // Each editable field exposes an "Edit <field>" chevron; reporter does not.
    expect(screen.getByRole('button', { name: 'Edit Priority' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Type' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit Reporter/i })).toBeNull();
  });

  it('reveals + commits a priority change through updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    expect(screen.queryByLabelText('Priority')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    // Priority now uses the shared Combobox picker (like Type/Assignee), not a
    // native <select> — drive it the same way: open, pick the option.
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', priority: 'low' }),
    );
  });

  it('reveals + commits a type change (kind is editable) through updateIssueAction', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Type' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Task' }));

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'wi_1', kind: 'task' }));
  });

  it('KEEPS the optimistic value on success without a whole-tree refresh', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    // The picked value stays on the rail — the 200 IS the confirmation, so the
    // success path must NOT router.refresh() (the inline-edit revert bug).
    await waitFor(() => expect(screen.getByText('Low')).toBeTruthy());
    expect(screen.queryByText('High')).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('commits an estimate edit on blur (and not on every keystroke)', () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Estimate' }));
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

// ── Sprint field (Subtask 2.4.14) ──────────────────────────────────────────
const sprintFixture = (over: Partial<SprintDto> = {}): SprintDto => ({
  id: 'sp',
  name: 'Sprint',
  goal: null,
  state: 'planned',
  startDate: null,
  endDate: null,
  completedAt: null,
  sequence: 1,
  issueCount: 0,
  committedPoints: null,
  committedIssueCount: null,
  ...over,
});

const sprints: SprintDto[] = [
  sprintFixture({ id: 'sp_active', name: 'Sprint 7', state: 'active', sequence: 7 }),
  sprintFixture({ id: 'sp_planned', name: 'Sprint 8', state: 'planned', sequence: 8 }),
  sprintFixture({ id: 'sp_done', name: 'Sprint 6', state: 'complete', sequence: 6 }),
];

function renderWithSprints(item = makeItem()) {
  return render(
    <CoreFieldsPanel
      item={item}
      members={members}
      workflow={workflow}
      parent={null}
      reporterIsSelf
      sprints={sprints}
    />,
  );
}

describe('CoreFieldsPanel — Sprint field (2.4.14)', () => {
  it('shows muted "Backlog" when an ACTIVE item is in no sprint', () => {
    renderWithSprints(makeItem({ sprintId: null, status: 'todo' }));
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Sprint' })).toBeTruthy();
  });

  it('shows "None" (not "Backlog") for a DONE item with no sprint — done is excluded from the backlog', () => {
    renderWithSprints(makeItem({ sprintId: null, status: 'done' }));
    // The Parent card also renders "None", so scope to the Sprint field card
    // (its "Edit Sprint" toggle → header row → Card content wrapper).
    const sprintCard = screen.getByRole('button', { name: 'Edit Sprint' }).parentElement!
      .parentElement!;
    expect(within(sprintCard).getByText('None')).toBeTruthy();
    expect(within(sprintCard).queryByText('Backlog')).toBeNull();
  });

  it('shows the sprint name when committed to a sprint', () => {
    renderWithSprints(makeItem({ sprintId: 'sp_active' }));
    expect(screen.getByText('Sprint 7')).toBeTruthy();
  });

  it('marks a completed current sprint with "(completed)"', () => {
    renderWithSprints(makeItem({ sprintId: 'sp_done' }));
    expect(screen.getByText('Sprint 6')).toBeTruthy();
    expect(screen.getByText('(completed)')).toBeTruthy();
  });

  it('is HIDDEN for an epic (epics span sprints)', () => {
    renderWithSprints(makeItem({ kind: 'epic', sprintId: null }));
    expect(screen.queryByRole('button', { name: 'Edit Sprint' })).toBeNull();
  });

  it('commits a sprint pick through setWorkItemSprint (Backlog-first sentinel)', () => {
    setSprintSpy.mockResolvedValue({
      updatedAt: '2026-06-17T10:00:00.000Z',
      sprintId: 'sp_active',
    });
    renderWithSprints(makeItem({ sprintId: null }));

    // The picker autoOpens on edit (no second click — that would toggle it shut).
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sprint' }));
    // Backlog sentinel is the first option; the active + planned sprints follow.
    expect(screen.getByRole('option', { name: 'Backlog' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Sprint 7/ }));

    expect(setSprintSpy).toHaveBeenCalledWith('wi_1', 'sp_active');
  });

  it('clearing to Backlog commits null', () => {
    setSprintSpy.mockResolvedValue({ updatedAt: '2026-06-17T10:00:00.000Z', sprintId: null });
    renderWithSprints(makeItem({ sprintId: 'sp_active' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Sprint' }));
    fireEvent.click(screen.getByRole('option', { name: 'Backlog' }));

    expect(setSprintSpy).toHaveBeenCalledWith('wi_1', null);
  });
});
