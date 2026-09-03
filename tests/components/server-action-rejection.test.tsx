// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { WorkflowDto, WorkflowStatusDto } from '@/lib/dto/workflows';

// A REJECTED Server Action, on both optimistic write surfaces (MOTIR-3948).
//
// The rail and the list rows were written for the two outcomes a Server Action
// RETURNS — accepted (`{ ok: true }`) and refused (`{ ok: false, error }`) — and
// both awaited the call with no `catch`. So the third outcome, a rejected
// promise, reached neither arm: the optimistic value stayed on screen, no
// message was raised, and the pending bar cleared. A write the server never took
// rendered exactly like one it did.
//
// The cause that makes this more than a network-blip case is deploy SKEW: Next
// salts every Server Action id with the build's own encryption key, so a tab
// older than the running build posts ids nobody recognises and gets a 404 for
// every write until it is reloaded. That is why the message forks, and why the
// two arms are asserted separately below — telling a reader with a stale page to
// "check your connection" sends them to retry a write that cannot succeed.

const push = vi.fn();
const refresh = vi.fn();
const toastSpy = vi.fn();
const updateIssueAction = vi.fn();
const changeStatusAction = vi.fn();

// The real `unstable_isUnrecognizedActionError` is KEPT — only the three router
// hooks are stubbed. The classifier under test is Next's own predicate, so a
// mocked stand-in would assert the mock rather than the behaviour.
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    useRouter: () => ({ push, refresh }),
    usePathname: () => '/items',
    useSearchParams: () => new URLSearchParams('peek=PROD-7'),
  };
});
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: (...args: unknown[]) => updateIssueAction(...args),
  changeStatusAction: (...args: unknown[]) => changeStatusAction(...args),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { serverActionRejectionKey } from '@/lib/utils/serverActionRejection';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

const SKEW_COPY = en.issueViews.actionSkewError;
const TRANSPORT_COPY = en.issueViews.actionTransportError;

function status(
  key: string,
  label: string,
  category: WorkflowStatusDto['category'],
  isInitial = false,
): WorkflowStatusDto {
  return {
    id: `st_${key}`,
    projectId: 'p1',
    key,
    label,
    category,
    color: null,
    position: key,
    isInitial,
  };
}

const STATUSES = [
  status('todo', 'To Do', 'todo', true),
  status('in_progress', 'In Progress', 'in_progress'),
  status('done', 'Done', 'done'),
];

const DATA: QuickViewData = {
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'Sign in with email and password.',
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: STATUSES, transitions: [], policyMode: 'open' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

const listWorkflow: WorkflowDto = {
  statuses: STATUSES,
  transitions: [],
  policyMode: 'open',
};

function listRow(): IssueRowData {
  return {
    id: 'wi_1',
    identifier: 'PROD-1',
    title: 'An issue',
    kind: 'task',
    type: null,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    priority: 'medium',
    reporterName: 'Owner',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    storyPoints: null,
    estimateLabel: null,
    storyPointsLabel: null,
    hasChildren: false,
  };
}

/** The rail row whose caption is `label`. */
function row(label: string) {
  const dt = screen.getByText(label, { selector: 'dt' });
  return dt.parentElement as HTMLElement;
}
function openRow(label: string) {
  fireEvent.click(within(row(label)).getByRole('button', { name: `Edit ${label}` }));
}

beforeEach(() => {
  updateIssueAction.mockReset();
  changeStatusAction.mockReset();
  toastSpy.mockReset();
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
  changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
});

afterEach(cleanup);

describe('classifying a rejected Server Action', () => {
  it('reads an UNRECOGNISED action as a stale PAGE, not a failed write', () => {
    // The error Next's client raises when the server answers 404
    // `x-nextjs-action-not-found` — i.e. this build has never heard of the
    // action id this tab is posting.
    const err = new UnrecognizedActionError('Server Action "40ab…" was not found on the server.');

    expect(serverActionRejectionKey(err)).toBe('actionSkewError');
  });

  it('reads anything else as a transport failure', () => {
    // Asserted separately from the arm above on purpose: the two produce
    // different instructions, and collapsing them is what would send a reader
    // with an out-of-date page to retry a write that cannot land.
    expect(serverActionRejectionKey(new TypeError('Failed to fetch'))).toBe('actionTransportError');
    expect(serverActionRejectionKey(undefined)).toBe('actionTransportError');
  });
});

describe('the quick-view rail — a rejected write', () => {
  it('rolls the status back to what the server last served and says the page is out of date', async () => {
    changeStatusAction.mockRejectedValue(new UnrecognizedActionError('not found on the server'));
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Status');
    fireEvent.click(await screen.findByRole('option', { name: 'Done' }));

    // The message lands ON THE ROW, the same place a refusal speaks — the modal
    // owns the viewport, so a toast about one field would appear away from it.
    await waitFor(() => expect(within(row('Status')).getByText(SKEW_COPY)).toBeTruthy());
    // And the optimistic value is GONE. Before this fix the row kept "Done"
    // with nothing said, for a transition the server never made.
    expect(within(row('Status')).getByText('In Progress')).toBeTruthy();
    expect(within(row('Status')).queryByText('Done')).toBeNull();
  });

  it('says try again when the rejection is not a skewed action', async () => {
    updateIssueAction.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Priority');
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));

    await waitFor(() => expect(within(row('Priority')).getByText(TRANSPORT_COPY)).toBeTruthy());
    expect(within(row('Priority')).getByText('Medium')).toBeTruthy();
  });
});

describe('the /items rows — a rejected write', () => {
  it('reverts the status cell and raises the error toast', async () => {
    changeStatusAction.mockRejectedValue(new UnrecognizedActionError('not found on the server'));
    render(
      <IssueListTable
        rows={[listRow()]}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: 1, page: 1, pageSize: 50 }}
        workflow={listWorkflow}
        members={[]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));

    // The list's grammar is a toast (the row is one line in a table; there is
    // nowhere on it to put a sentence), so this surface asserts the toast and
    // the rail above asserts the row.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: SKEW_COPY }),
    );
    await act(async () => {});
    expect(screen.getByText('To Do')).toBeTruthy();
  });

  it('reverts an assignee/priority-class edit too — the other write path', async () => {
    updateIssueAction.mockRejectedValue(new TypeError('Failed to fetch'));
    render(
      <IssueListTable
        rows={[listRow()]}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: 1, page: 1, pageSize: 50 }}
        workflow={listWorkflow}
        members={[
          { userId: 'u_ada', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: TRANSPORT_COPY }),
    );
    await act(async () => {});
    // The cell is back to Unassigned — `useUpdateField`'s `onFail` ran, which is
    // what the missing catch used to skip.
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });
});
