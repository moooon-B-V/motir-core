// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';

// The editable quick-view rail, part two (MOTIR-2567) — the OPTION-SOURCED rows
// and the two shared-hook collections.
//
// `quick-view-rail-edit.test.tsx` covers the chrome and the five self-contained
// editors, which need nothing from the payload but the item itself. This file
// covers the rows that can only exist because MOTIR-2562 widened the payload —
// Status, Assignee, Parent, Sprint, Labels, Components and the custom fields —
// plus the collection/estimation seams the story added. Those rows are the ones
// a peek-specific regression would land in: each one has a DIFFERENT write path
// (a gated action, a REST helper, a Server Action pair, a per-type editor), and
// the panel is the only place all seven are wired together.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams('peek=PROD-7'),
}));

const {
  updateIssueAction,
  changeStatusAction,
  setWorkItemSprint,
  listCandidateParentsAction,
  addLabelAction,
  removeLabelAction,
  addComponentAction,
  removeComponentAction,
  setCustomFieldValueAction,
} = vi.hoisted(() => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
  setWorkItemSprint: vi.fn(),
  listCandidateParentsAction: vi.fn(),
  addLabelAction: vi.fn(),
  removeLabelAction: vi.fn(),
  addComponentAction: vi.fn(),
  removeComponentAction: vi.fn(),
  setCustomFieldValueAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction,
  changeStatusAction,
}));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({ setWorkItemSprint }));
vi.mock('@/app/(authed)/items/actions', () => ({ listCandidateParentsAction }));
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction,
  removeLabelAction,
  addComponentAction,
  removeComponentAction,
}));
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({ setCustomFieldValueAction }));

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';

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

const MEMBERS = [
  { userId: 'u_ada', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member' as const },
  { userId: 'u_grace', name: '', email: 'grace@example.com', role: 'owner' as const },
];

const CUSTOM_FIELDS: CustomFieldWithValueDto[] = [
  {
    id: 'cf_text',
    key: 'team',
    label: 'Team',
    fieldType: 'text',
    description: null,
    options: [],
    value: { text: 'Platform', number: null, date: null, option: null, user: null },
  },
  {
    id: 'cf_number',
    key: 'risk',
    label: 'Risk',
    fieldType: 'number',
    description: null,
    options: [],
    value: null,
  },
  {
    id: 'cf_date',
    key: 'kickoff',
    label: 'Kickoff',
    fieldType: 'date',
    description: null,
    options: [],
    value: null,
  },
  {
    id: 'cf_select',
    key: 'tier',
    label: 'Tier',
    fieldType: 'select',
    description: null,
    options: [
      { id: 'o_gold', label: 'Gold', archived: false },
      { id: 'o_tin', label: 'Tin', archived: true },
    ],
    value: null,
  },
  {
    id: 'cf_user',
    key: 'reviewer',
    label: 'Reviewer',
    fieldType: 'user',
    description: null,
    options: [],
    value: null,
  },
];

const DATA: QuickViewData = {
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: 'Sign in with email and password.',
  type: 'code',
  executor: 'coding_agent',
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [{ id: 'l_api', name: 'api' }],
  components: [{ id: 'c_web', name: 'Web' }],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: CUSTOM_FIELDS,
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  hasChildren: false,
  canPlan: true,
  status: 'todo',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: STATUSES, transitions: [], policyMode: 'open' },
  members: MEMBERS,
  sprints: [
    { id: 's_1', name: 'Sprint 1', state: 'active', sequence: 1 },
    { id: 's_2', name: 'Sprint 2', state: 'planned', sequence: 2 },
  ],
  projectComponents: [
    { id: 'c_web', name: 'Web', description: null, defaultAssigneeId: null },
    { id: 'c_api', name: 'API', description: null, defaultAssigneeId: null },
  ],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

/** The rail row whose caption is `label`. */
function row(label: string) {
  const dt = screen.getByText(label, { selector: 'dt' });
  return dt.parentElement as HTMLElement;
}

/** Open a row's editor through its always-present caption chevron. */
function openRow(label: string) {
  fireEvent.click(within(row(label)).getByRole('button', { name: `Edit ${label}` }));
}

/** The bounded label autocomplete the Labels picker debounces a GET for. */
function stubLabelSearch(labels: { id: string; name: string }[]) {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ labels }) });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
  changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
  setWorkItemSprint.mockResolvedValue({ updatedAt: '2026-06-11T00:00:00.000Z', sprintId: 's_1' });
  listCandidateParentsAction.mockResolvedValue({ ok: true, candidates: [] });
  setCustomFieldValueAction.mockResolvedValue({ ok: true });
  stubLabelSearch([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the option-sourced rows — the payload IS the option source (MOTIR-2562)', () => {
  it('status commits through the GATED action, not the patch field, and repaints the pill', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Status');
    fireEvent.click(await screen.findByRole('option', { name: 'In Progress' }));

    // Status stopped being a patch field when finding #46 closed: it goes
    // through `changeStatusAction`, which re-validates the transition.
    await waitFor(() => expect(changeStatusAction).toHaveBeenCalledTimes(1));
    expect(changeStatusAction.mock.calls[0]![0]).toEqual({
      id: DATA.id,
      toStatusKey: 'in_progress',
    });
    expect(updateIssueAction).not.toHaveBeenCalled();
    // The row shows the picked status's LABEL and category, resolved from the
    // payload's own workflow — not the raw key.
    await waitFor(() => expect(within(row('Status')).getByText('In Progress')).toBeTruthy());
  });

  it('assignee falls back to the EMAIL when a member carries no name', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Assignee');
    fireEvent.click(await screen.findByRole('option', { name: /grace@example\.com/ }));

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ assigneeId: 'u_grace' }),
    );
    // `name || email` — a blank name must not render an empty assignee row.
    await waitFor(() =>
      expect(within(row('Assignee')).getByText('grace@example.com')).toBeTruthy(),
    );
  });

  it('sprint commits through its OWN endpoint helper and shows the picked name', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    // Empty and not done → the status-aware empty label is "Backlog".
    expect(within(row('Sprint')).getByText('Backlog')).toBeTruthy();
    openRow('Sprint');
    fireEvent.click(await screen.findByRole('option', { name: /Sprint 1/ }));

    // Sprint has its own POST route, not `updateIssueAction`.
    await waitFor(() => expect(setWorkItemSprint).toHaveBeenCalledWith(DATA.id, 's_1'));
    expect(updateIssueAction).not.toHaveBeenCalled();
    await waitFor(() => expect(within(row('Sprint')).getByText('Sprint 1')).toBeTruthy());
  });

  it('a THROWN sprint write is shaped into the row error, not an unhandled rejection', async () => {
    setWorkItemSprint.mockRejectedValue(new Error('500'));
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Sprint');
    fireEvent.click(await screen.findByRole('option', { name: /Sprint 1/ }));

    // The helper throws (it is a fetch wrapper, not an action returning a
    // result), so the row must translate it into the shared refusal shape.
    await waitFor(() =>
      expect(within(row('Sprint')).getByText(/Couldn’t update the sprint/)).toBeTruthy(),
    );
    // And the optimistic name is gone — the row is back to the served value.
    expect(within(row('Sprint')).getByText('Backlog')).toBeTruthy();
  });

  it('a DONE item reads "None" for an empty sprint — the label and the sentinel agree', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, statusCategory: 'done', statusLabel: 'Done', status: 'done' }}
      />,
    );
    // A done item is excluded from the backlog, so "Backlog" would be a lie.
    expect(within(row('Sprint')).getByText('None')).toBeTruthy();
  });

  it('an EPIC has no sprint row at all — epics span sprints', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, kind: 'epic', type: null }} />);
    expect(screen.queryByText('Sprint', { selector: 'dt' })).toBeNull();
    // …and no leaf-only Type / Executor rows either.
    expect(screen.queryByText('Type', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Executor', { selector: 'dt' })).toBeNull();
  });

  it('parent commits the picked id AND its label, so the row needs no re-read', async () => {
    listCandidateParentsAction.mockResolvedValue({
      ok: true,
      candidates: [{ id: 'wi_story', identifier: 'PROD-2', title: 'Auth', kind: 'story' }],
    });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Parent');
    // ParentPicker carries no `autoOpen` — its candidate list is fetched, so it
    // opens on the trigger like the detail rail's.
    fireEvent.click(within(row('Parent')).getByRole('combobox', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('option', { name: /PROD-2/ }));

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ parentId: 'wi_story' }),
    );
    // The picker hands the LABEL over with the id, so the row repaints without
    // a server re-read.
    await waitFor(() => expect(within(row('Parent')).getByText('Auth')).toBeTruthy());
  });

  it('the ESTIMATE row rejects a negative number without writing', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Estimate');
    const input = within(row('Estimate')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);

    // A negative duration is not a value the server should be asked for.
    await act(async () => {});
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(within(row('Estimate')).getByText('No estimate')).toBeTruthy();
  });

  it('the ESTIMATE row closes without a write when the value is unchanged', async () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, estimateMinutes: 90, estimateLabel: '1h 30m' }}
      />,
    );

    openRow('Estimate');
    const input = within(row('Estimate')).getByRole('spinbutton');
    fireEvent.blur(input);

    await act(async () => {});
    expect(updateIssueAction).not.toHaveBeenCalled();
  });

  it('the ESTIMATE row commits a valid number and Escape closes it', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Estimate');
    const input = within(row('Estimate')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ estimateMinutes: 120 }),
    );
    // The display label moves WITH the raw value — both axes, or the row shows
    // the old duration under a new number.
    await waitFor(() => expect(within(row('Estimate')).getByText('2h')).toBeTruthy());

    openRow('Estimate');
    fireEvent.keyDown(within(row('Estimate')).getByRole('spinbutton'), { key: 'Escape' });
    await waitFor(() => expect(within(row('Estimate')).queryByRole('spinbutton')).toBeNull());
  });

  it('the DUE DATE row commits BOTH axes — the raw instant and its label', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Due date');
    // The shipped DatePicker: a labelled trigger opening a day grid. The row
    // carries no aria-label of its own, so the primitive's default applies.
    fireEvent.click(within(row('Due date')).getByRole('button', { name: 'Date' }));
    const day = (await screen.findAllByRole('button')).find((b) =>
      /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(b.getAttribute('aria-label') ?? ''),
    )!;
    fireEvent.click(day);

    await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));
    // Raw value AND display label move together — a raw-only commit would leave
    // the OLD date rendered under the new one.
    const patch = updateIssueAction.mock.calls[0]![0];
    expect(patch.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    await waitFor(() => expect(within(row('Due date')).queryByText('No due date')).toBeNull());
  });

  it('the DUE DATE row clears to null through the picker’s Clear control', async () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, dueDate: '2026-07-01T00:00:00.000Z', dueLabel: 'Jul 1, 2026' }}
      />,
    );

    openRow('Due date');
    fireEvent.click(within(row('Due date')).getByRole('button', { name: 'Clear date' }));

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ dueDate: null }),
    );
    await waitFor(() => expect(within(row('Due date')).getByText('No due date')).toBeTruthy());
  });
});

describe('the collection rows — one behaviour, two chromes (MOTIR-2566)', () => {
  it('creates a label from the peek and re-renders chips from the action RESPONSE', async () => {
    addLabelAction.mockResolvedValue({
      ok: true,
      labels: [
        { id: 'l_api', name: 'api' },
        { id: 'l_perf', name: 'perf-q3' },
      ],
    });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    const input = screen.getByRole('combobox', { name: 'Labels' });
    fireEvent.change(input, { target: { value: 'perf-q3' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Create ‘perf-q3’' }));

    await waitFor(() =>
      expect(addLabelAction).toHaveBeenCalledWith({ workItemId: DATA.id, name: 'perf-q3' }),
    );
    // Confirmed from the response, and NO route refresh (the inline-edit rule).
    await waitFor(() => expect(screen.getAllByText('perf-q3').length).toBeGreaterThan(0));
    expect(refresh).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('toggling an ATTACHED label removes it; a refusal speaks in the picker', async () => {
    stubLabelSearch([{ id: 'l_api', name: 'api' }]);
    removeLabelAction.mockResolvedValue({ ok: false, error: 'Not allowed here.' });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    // The menu opens on focus (the picker fetches its window then).
    fireEvent.focus(screen.getByRole('combobox', { name: 'Labels' }));
    // The attached label is offered in the window; toggling it is a REMOVE.
    fireEvent.click(await screen.findByRole('option', { name: 'api' }));

    await waitFor(() =>
      expect(removeLabelAction).toHaveBeenCalledWith({ workItemId: DATA.id, labelId: 'l_api' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Not allowed here'),
    );
    expect(addLabelAction).not.toHaveBeenCalled();
  });

  it('the chip × removes a label directly', async () => {
    removeLabelAction.mockResolvedValue({ ok: true, labels: [] });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    fireEvent.click(screen.getByRole('button', { name: 'Remove api' }));

    await waitFor(() =>
      expect(removeLabelAction).toHaveBeenCalledWith({ workItemId: DATA.id, labelId: 'l_api' }),
    );
    // The chip set re-renders from the RESPONSE, so the chip is gone from the
    // open picker; closing the row falls back to the empty read value.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove api' })).toBeNull());
    fireEvent.click(within(row('Labels')).getByRole('button', { name: 'Close Labels' }));
    expect(within(row('Labels')).getByText('No labels')).toBeTruthy();
  });

  it('a failed autocomplete read leaves the window intact — the create row still works', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    addLabelAction.mockResolvedValue({ ok: true, labels: [{ id: 'l_x', name: 'x' }] });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    fireEvent.change(screen.getByRole('combobox', { name: 'Labels' }), { target: { value: 'x' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Create ‘x’' }));

    await waitFor(() => expect(addLabelAction).toHaveBeenCalled());
  });

  it('a non-ok autocomplete response is dropped rather than rendered as options', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ labels: [] }) });
    vi.stubGlobal('fetch', fetchSpy);
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    fireEvent.change(screen.getByRole('combobox', { name: 'Labels' }), { target: { value: 'ap' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects/PROD/labels?q=ap'));
    // No option rows from a rejected read; only the create affordance.
    expect(screen.queryByRole('option', { name: 'api' })).toBeNull();
  });

  it('components attach from the project taxonomy, filtered by the type-ahead', async () => {
    addComponentAction.mockResolvedValue({
      ok: true,
      components: [
        { id: 'c_web', name: 'Web' },
        { id: 'c_api', name: 'API' },
      ],
    });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Components');
    // Components are an ADMIN taxonomy: filtered client-side, never created.
    fireEvent.change(screen.getByRole('combobox', { name: 'Components' }), {
      target: { value: 'ap' },
    });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Web' })).toBeNull());
    fireEvent.click(screen.getByRole('option', { name: 'API' }));

    await waitFor(() =>
      expect(addComponentAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        componentId: 'c_api',
      }),
    );
    await waitFor(() => expect(within(row('Components')).getByText('API')).toBeTruthy());
  });

  it('toggling an ATTACHED component detaches it, and a refusal is shown', async () => {
    removeComponentAction.mockResolvedValue({ ok: false, error: 'Component is locked.' });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Components');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Components' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Web' }));

    await waitFor(() =>
      expect(removeComponentAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        componentId: 'c_web',
      }),
    );
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('locked'));
    expect(addComponentAction).not.toHaveBeenCalled();
  });

  it('the component chip × detaches directly, and an empty taxonomy says so', async () => {
    removeComponentAction.mockResolvedValue({ ok: true, components: [] });
    const { unmount } = render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Components');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Web' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Web' })).toBeNull());
    fireEvent.click(within(row('Components')).getByRole('button', { name: 'Close Components' }));
    expect(within(row('Components')).getByText('No components')).toBeTruthy();
    unmount();

    // The peek deliberately does NOT carry the detail card's "Manage components"
    // link: following it would navigate the page out from under the modal.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, components: [], projectComponents: [] }}
      />,
    );
    openRow('Components');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Components' }));
    expect(await screen.findByText('No components defined')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /manage components/i })).toBeNull();
  });
});

describe('the custom-field rows — the shared per-type editors (MOTIR-2599)', () => {
  it('reveals the empty fields behind a disclosure that promises REACH, not just sight', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    // One valued field renders; the other four hide. The label says "4 more
    // fields" — the disclosure is now the ONLY route to an empty field someone
    // wants to FILL, so it cannot promise merely to show them.
    expect(within(row('Team')).getByText('Platform')).toBeTruthy();
    expect(screen.queryByText('Risk', { selector: 'dt' })).toBeNull();
    const more = screen.getByRole('button', { name: /4 more fields/ });
    fireEvent.click(more);

    expect(screen.getByText('Risk', { selector: 'dt' })).toBeTruthy();
    // And it collapses again.
    fireEvent.click(screen.getByRole('button', { name: /show fewer fields/i }));
    expect(screen.queryByText('Risk', { selector: 'dt' })).toBeNull();
  });

  it('commits a TEXT field on blur and keeps the optimistic value', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Edit Team' }));
    const input = screen.getByRole('textbox', { name: 'Team' });
    fireEvent.change(input, { target: { value: 'Growth' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(setCustomFieldValueAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        fieldId: 'cf_text',
        value: 'Growth',
      }),
    );
    await waitFor(() => expect(within(row('Team')).getByText('Growth')).toBeTruthy());
  });

  it('an unchanged TEXT draft closes without a write', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Edit Team' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Team' }));

    await act(async () => {});
    expect(setCustomFieldValueAction).not.toHaveBeenCalled();
  });

  it('a refused commit SNAPS the value back and reopens the editor with the error', async () => {
    setCustomFieldValueAction.mockResolvedValue({ ok: false, error: 'Value is too long.' });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Edit Team' }));
    const input = screen.getByRole('textbox', { name: 'Team' });
    fireEvent.change(input, { target: { value: 'Growth' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('too long'));
    // The editor is open again on the SAME field, holding the served value.
    expect(screen.getByRole('textbox', { name: 'Team' })).toBeTruthy();
  });

  it('commits a NUMBER field, moving it out of the disclosure at once', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Risk')).getByRole('button', { name: 'Edit Risk' }));
    const input = screen.getByRole('textbox', { name: 'Risk' });
    fireEvent.change(input, { target: { value: '3.5' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(setCustomFieldValueAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        fieldId: 'cf_number',
        value: '3.5',
      }),
    );
    // The override applies at once, so the field is now VALUED — it survives
    // collapsing the disclosure, which now hides only the remaining three.
    await waitFor(() => expect(within(row('Risk')).getByText('3.5')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /show fewer fields/i }));
    expect(within(row('Risk')).getByText('3.5')).toBeTruthy();
    expect(screen.getByRole('button', { name: /3 more fields/ })).toBeTruthy();
  });

  it('commits a SELECT pick, offering None first and excluding archived options', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Tier')).getByRole('button', { name: 'Edit Tier' }));

    expect(await screen.findByRole('option', { name: 'None' })).toBeTruthy();
    // An archived option is not selectable for a NEW value.
    expect(screen.queryByRole('option', { name: 'Tin' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Gold' }));

    await waitFor(() =>
      expect(setCustomFieldValueAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        fieldId: 'cf_select',
        value: 'o_gold',
      }),
    );
    await waitFor(() => expect(within(row('Tier')).getByText('Gold')).toBeTruthy());
  });

  it('picking None on an already-empty SELECT closes without a write', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Tier')).getByRole('button', { name: 'Edit Tier' }));
    fireEvent.click(await screen.findByRole('option', { name: 'None' }));

    await act(async () => {});
    expect(setCustomFieldValueAction).not.toHaveBeenCalled();
  });

  it('commits a USER field from the member list the payload carries', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Reviewer')).getByRole('button', { name: 'Edit Reviewer' }));
    fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }));

    await waitFor(() =>
      expect(setCustomFieldValueAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        fieldId: 'cf_user',
        value: 'u_ada',
      }),
    );
    // Resolved optimistically from `members` — the peek never waits for a
    // re-read to put a name on the row.
    await waitFor(() => expect(within(row('Reviewer')).getByText('Ada Lovelace')).toBeTruthy());
  });

  it('commits a DATE field and closes the row', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Kickoff')).getByRole('button', { name: 'Edit Kickoff' }));
    // The per-type editor mounts the shipped DatePicker with `autoOpen`, so the
    // day grid is already up — pick the first day of the shown month.
    const day = (await screen.findAllByRole('button')).find((b) =>
      /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(b.getAttribute('aria-label') ?? ''),
    )!;
    fireEvent.click(day);

    await waitFor(() => expect(setCustomFieldValueAction).toHaveBeenCalledTimes(1));
    const call = setCustomFieldValueAction.mock.calls[0]![0];
    expect(call).toMatchObject({ workItemId: DATA.id, fieldId: 'cf_date' });
    // A custom DATE crosses as the date-only ISO the setter accepts, not the
    // full instant the built-in Due date uses.
    expect(call.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the caption chevron CLOSES an open picker row without committing', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    const open = within(row('Tier')).getByRole('button', { name: 'Edit Tier' });
    fireEvent.click(open);
    fireEvent.click(within(row('Tier')).getByRole('button', { name: 'Close Tier' }));

    await act(async () => {});
    expect(setCustomFieldValueAction).not.toHaveBeenCalled();
    expect(within(row('Tier')).getByRole('button', { name: 'Edit Tier' })).toBeTruthy();
  });

  it('the caption chevron COMMITS an open free-text row — a picker closes, text saves', async () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Edit Team' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Team' }), {
      target: { value: 'Growth' },
    });
    // Free text has no pick moment, so collapsing the row IS the commit —
    // otherwise a typed value would be silently discarded by the chevron.
    fireEvent.click(within(row('Team')).getByRole('button', { name: 'Close Team' }));

    await waitFor(() =>
      expect(setCustomFieldValueAction).toHaveBeenCalledWith({
        workItemId: DATA.id,
        fieldId: 'cf_text',
        value: 'Growth',
      }),
    );
  });

  it('seeds the NUMBER editor from the held value and skips an unchanged re-save', async () => {
    const fields: CustomFieldWithValueDto[] = [
      {
        ...CUSTOM_FIELDS[1]!,
        value: { text: null, number: 7, date: null, option: null, user: null },
      },
    ];
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, customFields: fields }} />);

    fireEvent.click(within(row('Risk')).getByRole('button', { name: 'Edit Risk' }));
    const input = screen.getByRole('textbox', { name: 'Risk' });
    // The draft is seeded from the number, stringified — not left blank, which
    // would turn "open the editor and click away" into a CLEAR.
    expect((input as HTMLInputElement).value).toBe('7');
    fireEvent.blur(input);

    await act(async () => {});
    expect(setCustomFieldValueAction).not.toHaveBeenCalled();
  });

  it('re-picking the SAME date closes without a write', async () => {
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const today = new Date();
    const [y, m, d] = [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()];
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const fields: CustomFieldWithValueDto[] = [
      {
        ...CUSTOM_FIELDS[2]!,
        value: {
          text: null,
          number: null,
          date: `${iso}T00:00:00.000Z`,
          option: null,
          user: null,
        },
      },
    ];
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, customFields: fields }} />);

    fireEvent.click(within(row('Kickoff')).getByRole('button', { name: 'Edit Kickoff' }));
    fireEvent.click(await screen.findByRole('button', { name: `${MONTHS[m]} ${d}, ${y}` }));

    // The held instant is sliced to a date before the comparison, so picking the
    // day already held is a no-op rather than a redundant write.
    await act(async () => {});
    expect(setCustomFieldValueAction).not.toHaveBeenCalled();
  });

  it('a refused PICKER commit shows the error box beside the reopened editor', async () => {
    setCustomFieldValueAction.mockResolvedValue({ ok: false, error: 'Tier is locked.' });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    fireEvent.click(screen.getByRole('button', { name: /4 more fields/ }));
    fireEvent.click(within(row('Tier')).getByRole('button', { name: 'Edit Tier' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Gold' }));

    // A picker editor has no Input to hang an inline error on, so the hook
    // renders its own alert box under the control.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Tier is locked'));
    expect(within(row('Tier')).getByText('None')).toBeTruthy();
  });

  it('renders a valued field whose typed slot is empty as the muted None', () => {
    // The typed-EAV row can hold a value object whose own column is null — the
    // field is "valued" by the split above but has nothing to print.
    const blank = { text: null, number: null, date: null, option: null, user: null };
    const fields: CustomFieldWithValueDto[] = [
      { ...CUSTOM_FIELDS[1]!, value: { ...blank } },
      { ...CUSTOM_FIELDS[2]!, value: { ...blank } },
      { ...CUSTOM_FIELDS[3]!, value: { ...blank } },
      { ...CUSTOM_FIELDS[4]!, value: { ...blank } },
    ];
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, customFields: fields }} />);

    for (const label of ['Risk', 'Kickoff', 'Tier', 'Reviewer']) {
      expect(within(row(label)).getByText('None')).toBeTruthy();
    }
    // Every field is valued, so there is no disclosure at all.
    expect(screen.queryByRole('button', { name: /more fields/ })).toBeNull();
  });

  it('marks a current-but-ARCHIVED select value in the read row', () => {
    const fields: CustomFieldWithValueDto[] = [
      {
        ...CUSTOM_FIELDS[3]!,
        value: {
          text: null,
          number: null,
          date: null,
          option: { id: 'o_tin', label: 'Tin', archived: true },
          user: null,
        },
      },
    ];
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, customFields: fields }} />);
    // The value stays visible with its mark — an archived option is excluded
    // from NEW selection, not erased from the items already holding it.
    expect(within(row('Tier')).getByText(/Tin/)).toBeTruthy();
    expect(within(row('Tier')).getByText(/archived/i)).toBeTruthy();
  });

  it('drops every custom-field chevron for a read-only actor', () => {
    render(
      <ProjectAccessProvider permissions={[]}>
        <IssueQuickViewPanel state="ready" data={DATA} />
      </ProjectAccessProvider>,
    );
    // Absent, not disabled (design panel 10): a disabled chevron advertises a
    // capability the viewer does not have.
    expect(within(row('Team')).queryByRole('button')).toBeNull();
    expect(within(row('Team')).getByText('Platform')).toBeTruthy();
  });
});

describe('the rail’s remaining commit shapes', () => {
  it('clears the assignee — no member matches the empty pick, so the name goes null', async () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, assigneeId: 'u_ada', assigneeName: 'Ada Lovelace' }}
      />,
    );

    openRow('Assignee');
    fireEvent.click(await screen.findByRole('option', { name: /unassigned/i }));

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ assigneeId: null }),
    );
    await waitFor(() => expect(within(row('Assignee')).getByText(/unassigned/i)).toBeTruthy());
  });

  it('clears the parent — "No parent" commits null with no optimistic label', async () => {
    listCandidateParentsAction.mockResolvedValue({
      ok: true,
      candidates: [{ id: 'wi_story', identifier: 'PROD-2', title: 'Auth', kind: 'story' }],
    });
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...DATA,
          parentId: 'wi_story',
          parent: { identifier: 'PROD-2', title: 'Auth', kind: 'story' },
        }}
      />,
    );

    openRow('Parent');
    fireEvent.click(within(row('Parent')).getByRole('combobox', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('option', { name: 'No parent' }));

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ parentId: null }),
    );
    await waitFor(() => expect(within(row('Parent')).getByText('None')).toBeTruthy());
  });

  it('moves an item back to the BACKLOG — the empty sprint option commits null', async () => {
    setWorkItemSprint.mockResolvedValue({
      updatedAt: '2026-06-11T00:00:00.000Z',
      sprintId: null,
    });
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, sprintId: 's_1', sprintName: 'Sprint 1' }}
      />,
    );

    openRow('Sprint');
    fireEvent.click(await screen.findByRole('option', { name: 'Backlog' }));

    await waitFor(() => expect(setWorkItemSprint).toHaveBeenCalledWith(DATA.id, null));
    await waitFor(() => expect(within(row('Sprint')).getByText('Backlog')).toBeTruthy());
  });

  it('clears the estimate — an emptied input commits null, label and all', async () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, estimateMinutes: 90, estimateLabel: '1h 30m' }}
      />,
    );

    openRow('Estimate');
    const input = within(row('Estimate')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ estimateMinutes: null }),
    );
    await waitFor(() => expect(within(row('Estimate')).getByText('No estimate')).toBeTruthy());
  });

  it('changes the work TYPE and the EXECUTOR, repainting each row’s glyph', async () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, executor: null }} />);

    // Executor is empty but the type is set, so the segmented control still has
    // a value to seed from — the type's default, not a blank control.
    openRow('Executor');
    fireEvent.click(within(row('Executor')).getByRole('button', { name: 'Human' }));
    await waitFor(() =>
      expect(updateIssueAction.mock.calls[0]![0]).toMatchObject({ executor: 'human' }),
    );

    openRow('Type');
    fireEvent.click(await screen.findByRole('option', { name: 'Design' }));
    await waitFor(() =>
      expect(updateIssueAction.mock.calls[1]![0]).toMatchObject({ type: 'design' }),
    );
    await waitFor(() => expect(within(row('Type')).getByText('Design')).toBeTruthy());
  });

  it('shows the per-issue cap hint once the item holds the maximum labels', () => {
    const labels = Array.from({ length: LABELS_PER_ISSUE_LIMIT }, (_, i) => ({
      id: `l_${i}`,
      name: `label-${i}`,
    }));
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, labels }} />);

    openRow('Labels');
    expect(
      screen.getByText(
        `Label limit reached (${LABELS_PER_ISSUE_LIMIT}) — remove one to add another.`,
      ),
    ).toBeTruthy();
  });

  it('attaches an UNSELECTED label by toggling it from the window', async () => {
    stubLabelSearch([{ id: 'l_perf', name: 'perf-q3' }]);
    addLabelAction.mockResolvedValue({
      ok: true,
      labels: [
        { id: 'l_api', name: 'api' },
        { id: 'l_perf', name: 'perf-q3' },
      ],
    });
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Labels' }));
    fireEvent.click(await screen.findByRole('option', { name: 'perf-q3' }));

    // Toggling an unattached option is an ADD by NAME — the label vocabulary is
    // a folksonomy, so the action takes the name, not the id.
    await waitFor(() =>
      expect(addLabelAction).toHaveBeenCalledWith({ workItemId: DATA.id, name: 'perf-q3' }),
    );
    expect(removeLabelAction).not.toHaveBeenCalled();
  });

  it('drops a STALE autocomplete response that lands after a newer one', async () => {
    // The debounced reads are not guaranteed to return in order; an older
    // window overwriting a newer one would show options for a query the user
    // has already moved past.
    const resolvers: ((v: unknown) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => resolvers.push(resolve))),
    );
    render(<IssueQuickViewPanel state="ready" data={DATA} />);

    openRow('Labels');
    const input = screen.getByRole('combobox', { name: 'Labels' });
    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(resolvers.length).toBe(1));
    fireEvent.change(input, { target: { value: 'ap' } });
    await waitFor(() => expect(resolvers.length).toBe(2));

    // The NEWER read lands first, then the older one.
    await act(async () => {
      resolvers[1]!({ ok: true, json: async () => ({ labels: [{ id: 'l_new', name: 'apex' }] }) });
    });
    await act(async () => {
      resolvers[0]!({ ok: true, json: async () => ({ labels: [{ id: 'l_old', name: 'aged' }] }) });
    });

    expect(screen.getByRole('option', { name: 'apex' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'aged' })).toBeNull();
  });
});
