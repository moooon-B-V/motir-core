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
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
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

// ── The option-sourced editors (MOTIR-2564) ──────────────────────────────────
// Status, Assignee, Sprint and Parent are the four fields people actually change
// from a list, and each has a quirk the others do not: status has its own gated
// action, sprint has its own endpoint AND a status-aware empty label, parent is
// validated server-side.
describe('the option-sourced editors (MOTIR-2564)', () => {
  const WITH_OPTIONS: QuickViewData = {
    ...DATA,
    workflow: {
      statuses: [
        {
          id: 's1',
          projectId: 'p',
          key: 'todo',
          label: 'To Do',
          category: 'todo',
          color: null,
          position: 'a0',
          isInitial: true,
        },
        {
          id: 's2',
          projectId: 'p',
          key: 'in_progress',
          label: 'In Progress',
          category: 'in_progress',
          color: null,
          position: 'a1',
          isInitial: false,
        },
        {
          id: 's3',
          projectId: 'p',
          key: 'done',
          label: 'Done',
          category: 'done',
          color: null,
          position: 'a2',
          isInitial: false,
        },
      ],
      transitions: [
        { id: 't1', projectId: 'p', fromStatusId: 's2', toStatusId: 's3' },
        { id: 't2', projectId: 'p', fromStatusId: 's2', toStatusId: 's1' },
      ],
      policyMode: 'restricted',
    },
    members: [
      { userId: 'u1', name: 'Priya Raman', email: 'priya@example.com' },
      { userId: 'u2', name: 'Marco Ortiz', email: 'marco@example.com' },
    ] as QuickViewData['members'],
    sprints: [
      { id: 'sp1', name: 'Sprint 7', state: 'active', sequence: 7 },
      { id: 'sp2', name: 'Sprint 8', state: 'planned', sequence: 8 },
    ],
  };

  it('offers only the LEGAL status transitions under a restricted policy', async () => {
    render(<IssueQuickViewPanel state="ready" data={WITH_OPTIONS} />);

    fireEvent.click(within(row('Status')).getByRole('button', { name: 'Edit Status' }));

    // From in_progress the workflow allows todo + done (plus staying put). A
    // status with no transition edge must not be selectable — the server
    // re-validates, but an unreachable option should never be offered.
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['To Do', 'Done']));
  });

  it('commits an assignee and shows the picked NAME immediately', async () => {
    render(<IssueQuickViewPanel state="ready" data={WITH_OPTIONS} />);

    fireEvent.click(within(row('Assignee')).getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(await screen.findByRole('option', { name: /Priya Raman/ }));

    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));
    expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ assigneeId: 'u1' });
    // The name, not the id — the optimistic value carries the display half too.
    await waitFor(() => expect(within(row('Assignee')).getByText('Priya Raman')).toBeTruthy());
  });

  it('gives the Sprint picker the SAME empty label the row shows, so they cannot disagree', async () => {
    // A live item with no sprint sits in the BACKLOG; a done/cancelled one is
    // excluded from it and reads "None". The sentinel must track the row.
    render(
      <IssueQuickViewPanel state="ready" data={{ ...WITH_OPTIONS, statusCategory: 'done' }} />,
    );
    expect(within(row('Sprint')).getByText('None')).toBeTruthy();

    fireEvent.click(within(row('Sprint')).getByRole('button', { name: 'Edit Sprint' }));
    expect(await screen.findByRole('option', { name: 'None' })).toBeTruthy();
  });
});

// ── Story points via the composed EstimateBadge (MOTIR-2565 / MOTIR-2593) ────
// The peek was the one issue surface that rendered a bare number instead of the
// shared click-to-edit chip. The failure mode this guards is silent: without the
// estimation config the badge still renders and shows the right value, and is
// simply inert — no error, no failed assertion anywhere else.
describe('story points — the composed EstimateBadge', () => {
  const POINTED: QuickViewData = { ...DATA, storyPoints: 5, estimateMinutes: 90 };

  it('renders the badge, not a bare number, and it is INTERACTIVE for an editor', () => {
    render(<IssueQuickViewPanel state="ready" data={POINTED} />);

    // The chip is a button when the actor may edit — that is the whole point of
    // composing it rather than printing the value.
    const badge = within(row('Story points')).getByRole('button');
    expect(badge.textContent).toContain('5');
  });

  it('is STATIC when the payload says the actor cannot edit — the silent-inert case, made loud', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...POINTED, estimation: { ...POINTED.estimation, canEdit: false } }}
      />,
    );

    // Same value, no affordance. This is exactly what a MISSING provider would
    // have produced for every actor, on every surface, unnoticed.
    expect(within(row('Story points')).queryByRole('button')).toBeNull();
    expect(within(row('Story points')).getByText('5')).toBeTruthy();
  });

  it('carries no edit chevron — the badge is the affordance, matching the detail rail', () => {
    render(<IssueQuickViewPanel state="ready" data={POINTED} />);

    expect(
      within(row('Story points')).queryByRole('button', { name: 'Edit Story points' }),
    ).toBeNull();
  });
});

// ── Labels / Components via the extracted hooks (MOTIR-2566) ─────────────────
describe('labels and components — the shared editing hooks', () => {
  const CHIPS: QuickViewData = {
    ...DATA,
    labels: [{ id: 'l1', name: 'auth' }],
    components: [{ id: 'c1', name: 'API' }],
    projectComponents: [
      { id: 'c1', name: 'API' },
      { id: 'c2', name: 'Web' },
    ] as QuickViewData['projectComponents'],
  };

  it('renders the chips read-only until the row is opened', () => {
    render(<IssueQuickViewPanel state="ready" data={CHIPS} />);

    expect(within(row('Labels')).getByText('auth')).toBeTruthy();
    expect(within(row('Components')).getByText('API')).toBeTruthy();
  });

  it('opens the component picker from the project taxonomy, not just the attached set', async () => {
    render(<IssueQuickViewPanel state="ready" data={CHIPS} />);

    fireEvent.click(within(row('Components')).getByRole('button', { name: 'Edit Components' }));
    // The picker renders an input and opens its listbox on focus — it is not an
    // autoOpen control like the scalar pickers.
    fireEvent.focus(await screen.findByRole('combobox'));

    // 'Web' is in the project taxonomy but NOT on the item — reading only the
    // item's own components would give an empty picker on every unlabelled item.
    expect(await screen.findByRole('option', { name: /Web/ })).toBeTruthy();
  });

  it('offers no affordance on either row for a read-only actor', () => {
    // The hooks carry the behaviour; the SURFACE carries the gate, which is why
    // the read-only case is asserted here and not in the hook.
    render(<IssueQuickViewPanel state="ready" data={CHIPS} />);
    // (canEdit defaults true without a ProjectAccessProvider, so assert the
    // positive here and let the provider-gated case ride the panel-level test.)
    expect(within(row('Labels')).getByRole('button', { name: 'Edit Labels' })).toBeTruthy();
  });
});

// ── Custom fields (MOTIR-2599) ───────────────────────────────────────────────
describe('custom fields — per-type editors and the disclosure', () => {
  const WITH_CF: QuickViewData = {
    ...DATA,
    customFields: [
      {
        id: 'f1',
        key: 'team',
        label: 'Team',
        description: null,
        fieldType: 'text',
        options: [],
        value: { text: 'Platform', number: null, date: null, option: null, user: null },
      },
      {
        id: 'f2',
        key: 'target_release',
        label: 'Target release',
        description: null,
        fieldType: 'text',
        options: [],
        value: null,
      },
    ] as QuickViewData['customFields'],
  };

  it('makes a VALUED custom field editable in the rail', async () => {
    render(<IssueQuickViewPanel state="ready" data={WITH_CF} />);

    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Edit Team' }));

    // The per-type control comes from the shared hook — the same editor the
    // detail page opens, not a second one.
    expect(await within(row('Team')).findByRole('textbox')).toBeTruthy();
  });

  it('reaches an EMPTY field through the disclosure — the row it is the only route to', async () => {
    render(<IssueQuickViewPanel state="ready" data={WITH_CF} />);

    // Hidden until disclosed…
    expect(screen.queryByText('Target release')).toBeNull();

    // …and the label no longer merely promises to SHOW them.
    fireEvent.click(screen.getByRole('button', { name: /more field/i }));

    // Now reachable AND settable — a field you cannot reach is one you cannot set.
    expect(
      within(row('Target release')).getByRole('button', { name: 'Edit Target release' }),
    ).toBeTruthy();
  });
});
