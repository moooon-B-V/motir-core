// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';

// The editable quick-view rail (MOTIR-2563) — the chrome, the five
// self-contained editors, and the behind-the-modal signal.
//
// These assertions are written against the DESIGN's decisions (panels 7-9, 12),
// not just the code, because most of them are choices that would otherwise be
// silently re-made: the affordance is always rendered rather than hover-revealed
// (touch + keyboard), pending shows no spinner (the value is already on screen),
// a refusal reverts and speaks ON THE ROW, and the host surface re-reads once on
// CLOSE rather than per edit.

const push = vi.fn();
const refresh = vi.fn();
let searchParamsString = 'peek=PROD-7';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

const updateIssueAction = vi.fn();
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: (...args: unknown[]) => updateIssueAction(...args),
  changeStatusAction: vi.fn(),
}));

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { IssueQuickViewController } from '@/app/(authed)/items/_components/IssueQuickViewController';
import { Modal } from '@/components/ui/Modal';

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
  hasChildren: false,
  canPlan: true,
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
};

beforeEach(() => {
  updateIssueAction.mockReset();
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
  refresh.mockReset();
  searchParamsString = 'peek=PROD-7';
});

afterEach(cleanup);

/** The rail row whose caption is `label`. */
function row(label: string) {
  const dt = screen.getByText(label, { selector: 'dt' });
  return dt.parentElement as HTMLElement;
}

describe('the editable rail — the affordance (design panel 7)', () => {
  it('renders an edit control on each of the five self-contained rows', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    for (const label of ['Priority', 'Type', 'Executor', 'Due date', 'Estimate']) {
      expect(within(row(label)).getByRole('button', { name: `Edit ${label}` })).toBeTruthy();
    }
  });

  it('is ALWAYS rendered, not revealed on hover — a touch or keyboard user must reach it', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    // No hover has happened. The affordance is present and focusable anyway;
    // reveal-on-hover would make it unreachable on touch and invisible to a
    // keyboard user, which is why the design rejected it.
    const chevron = within(row('Priority')).getByRole('button', { name: 'Edit Priority' });
    chevron.focus();
    expect(document.activeElement).toBe(chevron);
  });

  it('leaves the READ-ONLY rows without one — the boundary is visible, not just documented', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    // Reporter is read-only on the detail rail too, so it is read-only here.
    expect(within(row('Reporter')).queryByRole('button')).toBeNull();
  });
});

describe('the editable rail — committing (design panel 9)', () => {
  it('commits through the shipped action, keyed by the item id, and KEEPS the picked value', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));

    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));
    expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({
      id: DATA.id,
      expectedUpdatedAt: DATA.updatedAt,
      priority: 'high',
    });
    // No route refresh on success — that fan-out is the documented cause of
    // `bug-inline-status-revert-on-second-edit`.
    expect(refresh).not.toHaveBeenCalled();
    // The optimistic value stays; the response was only the confirmation.
    await waitFor(() => expect(within(row('Priority')).getByText('High')).toBeTruthy());
  });

  it('ADVANCES the concurrency token, so a SECOND edit in the same session succeeds', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));
    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));

    fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Low' }));
    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(2));

    // The SECOND call must carry the token the FIRST write returned, not the one
    // the payload was fetched with — submitting the stale one is exactly the
    // failure the list's ledger exists to prevent.
    expect(updateIssueAction.mock.calls[1]![0].expectedUpdatedAt).toBe('2026-06-11T00:00:00.000Z');
  });

  it('REVERTS the value and speaks on the row when the write is refused', async () => {
    updateIssueAction.mockResolvedValue({ ok: false, error: 'A subtask cannot be re-typed.' });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));

    // The message belongs to the FIELD, not a toast — the modal owns the
    // viewport, so a toast about one row would appear far from it.
    await waitFor(() =>
      expect(within(row('Priority')).getByText('A subtask cannot be re-typed.')).toBeTruthy(),
    );
    // And the value is back to what the server last served.
    expect(within(row('Priority')).getByText('Medium')).toBeTruthy();
  });

  it('raises the rail-level STALE notice when someone else wrote first', async () => {
    updateIssueAction.mockResolvedValue({
      ok: false,
      error: 'Someone else edited it.',
      stale: true,
    });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));

    // Not a field error: the whole payload is behind, so the notice sits above
    // rows that may all have moved.
    await waitFor(() =>
      expect(screen.getByText(/changed while the quick view was open/i)).toBeTruthy(),
    );
  });
});

describe('the editable rail — inside the real Modal', () => {
  it('opens a picker and commits from inside the dialog, not just a bare div', async () => {
    // The peek IS a Radix dialog. A picker that renders fine in a plain div can
    // still lose to the dialog's focus scope, so the control is exercised in the
    // real Modal rather than assumed to work.
    render(
      <Modal open onOpenChange={() => {}} srTitle="Quick view">
        <IssueQuickViewPanel state="ready" data={DATA} />
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Priority' }));
    const option = await screen.findByRole('option', { name: 'High' });
    fireEvent.click(option);

    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));
  });
});

describe('the surface behind the modal (design panel 12)', () => {
  it('does NOT refresh while the peek is open, and refreshes ONCE on close after an edit', async () => {
    // The controller fetches the payload on mount, so the stub goes in FIRST.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => DATA }));
    const { rerender } = render(<IssueQuickViewController />);

    await screen.findByRole('button', { name: 'Edit Priority' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));
    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));

    // Still open: nothing behind it has been re-read.
    expect(refresh).not.toHaveBeenCalled();

    // Close the peek (the `?peek` param clears).
    searchParamsString = '';
    await act(async () => {
      rerender(<IssueQuickViewController />);
    });

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });

  it('does not refresh on close when nothing was edited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => DATA }));
    const { rerender } = render(<IssueQuickViewController />);
    await screen.findByRole('button', { name: 'Edit Priority' });

    searchParamsString = '';
    await act(async () => {
      rerender(<IssueQuickViewController />);
    });

    expect(refresh).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
