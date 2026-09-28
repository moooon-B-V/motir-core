// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { QuickViewData } from '@/lib/dto/quickView';

// Story MOTIR-6575 · MOTIR-6674 — the OBSOLESCENCE field on the item page's core
// fields rail AND in the quick view, per
// design/work-items/core-fields--obsolescence.mock.html: Current / each mark as
// the badge / the Segmented + note editor / LOCKED on an unfinished card with the
// reason visible / the finished-card refusal drawn IN the field / the header
// badge that scrolls to the field.

const { updateIssueAction, changeStatusAction, refresh, toast } = vi.hoisted(() => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction,
  changeStatusAction,
  getWorkItemPlacementAction: vi.fn(),
  fileWorkItemAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  setWorkItemSprint: vi.fn(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
  listProjectFoldersAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn(),
  removeLabelAction: vi.fn(),
  addComponentAction: vi.fn(),
  removeComponentAction: vi.fn(),
}));

import { CoreFieldsPanel } from '@/app/(authed)/items/[key]/_components/CoreFieldsPanel';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { ObsolescenceHeaderLink } from '@/components/issues/ObsolescenceBadge';
import {
  OptimisticMarkProvider,
  OptimisticObsolescenceHeaderLink,
} from '@/app/(authed)/items/[key]/_components/OptimisticMarkProvider';

const EN = enMessages as Record<string, unknown>;
const ZH = zhMessages as Record<string, unknown>;

const LOCKED_HINT = 'Only a finished item can be marked — archive it instead';
const REFUSED = 'This item is no longer finished, so it can’t be marked. Reload to see its status.';

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
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a1',
      isInitial: false,
    },
    {
      id: 's3',
      projectId: 'p1',
      key: 'cancelled',
      label: 'Cancelled',
      category: 'done',
      color: null,
      position: 'a2',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'p1',
    parentId: null,
    kind: 'story',
    key: 7,
    identifier: 'PROD-7',
    title: 'Retire the v1 importer',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'done',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u_r',
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
    obsolescence: null,
    obsolescenceNoteMd: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(item: WorkItemDto, { readOnly = false, messages = EN, locale = 'en' } = {}) {
  const tree = <CoreFieldsPanel item={item} members={[]} workflow={workflow} parent={null} />;
  return renderWithIntl(
    readOnly ? <ProjectAccessProvider permissions={[]}>{tree}</ProjectAccessProvider> : tree,
    { messages, locale },
  );
}

/** The item page's Obsolescence card — its anchor wraps it. */
function card() {
  return document.getElementById('obsolescence-field')!;
}

function openCardEditor() {
  fireEvent.click(within(card()).getByRole('button', { name: 'Edit Obsolescence' }));
  return within(card()).getByRole('group', { name: 'Obsolescence' });
}

beforeEach(() => {
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-09-03T00:00:00.000Z' });
  changeStatusAction.mockReset();
  changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-09-03T00:00:00.000Z' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('item page — the Obsolescence card', () => {
  it('reads Current on an unmarked card, with no badge and no note', () => {
    renderPanel(makeItem());
    expect(within(card()).getByText('Current')).toBeTruthy();
    expect(card().querySelector('[data-obsolescence]')).toBeNull();
    expect(card().querySelector('[data-obsolescence-note]')).toBeNull();
  });

  it.each([
    ['outdated', 'Outdated'],
    ['deprecated', 'Deprecated'],
  ] as const)('reads %s as the badge, with its note beneath', (mark, word) => {
    renderPanel(makeItem({ obsolescence: mark, obsolescenceNoteMd: 'Read PROD-9 instead.' }));
    const badge = card().querySelector(`[data-obsolescence="${mark}"]`)!;
    expect(badge.textContent).toBe(word);
    expect(badge.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(card().querySelector('[data-obsolescence-note]')!.textContent).toContain(
      'Read PROD-9 instead.',
    );
  });

  it('collapses a long note behind Show more', () => {
    renderPanel(makeItem({ obsolescence: 'outdated', obsolescenceNoteMd: 'x'.repeat(120) }));
    const note = card().querySelector('[data-obsolescence-note]')!;
    expect(note.className).toContain('line-clamp-1');
    fireEvent.click(within(card()).getByRole('button', { name: 'Show more' }));
    expect(note.className).not.toContain('line-clamp-1');
    expect(within(card()).getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('marks through the Segmented — optimistic, the editor stays open for the note', async () => {
    renderPanel(makeItem());
    const group = openCardEditor();
    expect(
      within(group).getByRole('button', { name: 'Current' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Deprecated' }));
    });
    expect(updateIssueAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', obsolescence: 'deprecated' }),
    );
    const stillOpen = within(card()).getByRole('group', { name: 'Obsolescence' });
    expect(
      within(stillOpen).getByRole('button', { name: 'Deprecated' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Current clears the mark — there is no separate Clear', async () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }));
    const group = openCardEditor();
    expect(within(card()).queryByRole('button', { name: 'Clear' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Current' }));
    });
    expect(updateIssueAction).toHaveBeenCalledWith(expect.objectContaining({ obsolescence: null }));
  });

  it('saves the note on its own Save and closes the editor', async () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }));
    openCardEditor();
    const save = within(card()).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(card()).getByLabelText('Why is it marked?'), {
      target: { value: 'Superseded by PROD-9.' },
    });
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Save' }));
    });
    expect(updateIssueAction).toHaveBeenCalledWith(
      expect.objectContaining({ obsolescenceNoteMd: 'Superseded by PROD-9.' }),
    );
    expect(within(card()).queryByRole('group', { name: 'Obsolescence' })).toBeNull();
    expect(card().querySelector('[data-obsolescence-note]')!.textContent).toContain(
      'Superseded by PROD-9.',
    );
  });

  it('Cancel drops the draft and writes nothing', () => {
    renderPanel(makeItem({ obsolescence: 'outdated', obsolescenceNoteMd: 'Old note.' }));
    openCardEditor();
    fireEvent.change(within(card()).getByLabelText('Why is it marked?'), {
      target: { value: 'Changed my mind' },
    });
    fireEvent.click(within(card()).getByRole('button', { name: 'Cancel' }));
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(card().querySelector('[data-obsolescence-note]')!.textContent).toContain('Old note.');
  });

  it('LOCKS both marks on an unfinished card and says why in a visible line', () => {
    renderPanel(makeItem({ status: 'todo' }));
    const group = openCardEditor();
    for (const name of ['Outdated', 'Deprecated']) {
      const b = within(group).getByRole('button', { name });
      expect(b.hasAttribute('disabled')).toBe(true);
      expect(b.getAttribute('title')).toBe(LOCKED_HINT);
    }
    expect(within(group).getByRole('button', { name: 'Current' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(card().querySelector('[data-obsolescence-locked-hint]')!.textContent).toBe(LOCKED_HINT);
  });

  it('draws the finished-card refusal IN the field, reverts, and raises no toast', async () => {
    updateIssueAction.mockResolvedValueOnce({
      ok: false,
      error: REFUSED,
      code: 'OBSOLESCENCE_REQUIRES_FINISHED',
    });
    renderPanel(makeItem());
    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Outdated' }));
    });
    expect(within(card()).getByRole('alert').textContent).toBe(REFUSED);
    expect(
      within(card()).getByRole('button', { name: 'Current' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(toast).not.toHaveBeenCalled();
  });

  it('a stale conflict reverts, toasts and re-reads', async () => {
    updateIssueAction.mockResolvedValueOnce({ ok: false, stale: true, error: 'stale' });
    renderPanel(makeItem());
    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Outdated' }));
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(within(card()).queryByRole('alert')).toBeNull();
  });

  it('a read-only viewer sees the badge and a DISABLED chevron, and no editor', () => {
    renderPanel(makeItem({ obsolescence: 'deprecated' }), { readOnly: true });
    expect(card().querySelector('[data-obsolescence="deprecated"]')).toBeTruthy();
    const chevron = within(card()).getByRole('button', {
      name: 'Obsolescence — You have read-only access to this project',
    });
    expect(chevron.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(chevron);
    expect(within(card()).queryByRole('group')).toBeNull();
  });

  it('renders in zh', () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }), { messages: ZH, locale: 'zh' });
    const zh = (ZH.workItems as { obsolescence: { value: { outdated: string } } }).obsolescence;
    expect(card().querySelector('[data-obsolescence]')!.textContent).toBe(zh.value.outdated);
  });
});

describe('the header badge points at the field', () => {
  it('scrolls to and focuses the field, and edits nothing', () => {
    renderWithIntl(
      <>
        <ObsolescenceHeaderLink mark="outdated" />
        <div id="obsolescence-field" tabIndex={-1} />
      </>,
      { messages: EN, locale: 'en' },
    );
    const target = document.getElementById('obsolescence-field')!;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    fireEvent.click(
      screen.getByRole('button', { name: 'Outdated — Go to the Obsolescence field' }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    expect(document.activeElement).toBe(target);
    expect(updateIssueAction).not.toHaveBeenCalled();
  });
});

// ── The quick view ─────────────────────────────────────────────────────────────

const DATA: QuickViewData = {
  folderId: null,
  folderPath: [],
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Retire the v1 importer',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'story',
  statusLabel: 'Done',
  statusCategory: 'done',
  descriptionMd: null,
  explanationMd: null,
  type: null,
  executor: null,
  difficulty: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  status: 'done',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow,
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

function renderQuickView(data: Partial<QuickViewData> = {}) {
  return renderWithIntl(<IssueQuickViewPanel state="ready" data={{ ...DATA, ...data }} />, {
    messages: EN,
    locale: 'en',
  });
}

/** The rail row whose caption is `label`. */
function row(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement as HTMLElement;
}

describe('quick view — the Obsolescence rail field', () => {
  it('reads Current when unmarked, and the header carries no badge', () => {
    renderQuickView();
    expect(within(row('Obsolescence')).getByText('Current')).toBeTruthy();
    expect(document.querySelector('[data-obsolescence-link]')).toBeNull();
  });

  it('a marked card shows the badge on the row AND a header link to the peek’s own field', () => {
    renderQuickView({ obsolescence: 'deprecated' });
    expect(row('Obsolescence').querySelector('[data-obsolescence="deprecated"]')).toBeTruthy();
    const link = document.querySelector('[data-obsolescence-link="deprecated"]')!;
    expect(link.getAttribute('aria-label')).toBe('Deprecated — Go to the Obsolescence field');
    expect(document.getElementById('obsolescence-field-peek')).toBeTruthy();
  });

  it('marks through the rail editor — the optimistic badge shows at once', async () => {
    renderQuickView();
    fireEvent.click(within(row('Obsolescence')).getByRole('button', { name: 'Edit Obsolescence' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Obsolescence' })).getByRole('button', {
          name: 'Outdated',
        }),
      );
    });
    expect(updateIssueAction).toHaveBeenCalledWith(
      expect.objectContaining({ obsolescence: 'outdated' }),
    );
    await waitFor(() =>
      expect(row('Obsolescence').querySelector('[data-obsolescence="outdated"]')).toBeTruthy(),
    );
  });

  it('locks both marks on an unfinished card', () => {
    renderQuickView({ status: 'todo', statusLabel: 'To Do', statusCategory: 'todo' });
    fireEvent.click(within(row('Obsolescence')).getByRole('button', { name: 'Edit Obsolescence' }));
    const group = screen.getByRole('group', { name: 'Obsolescence' });
    expect(within(group).getByRole('button', { name: 'Deprecated' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText(LOCKED_HINT)).toBeTruthy();
  });

  it('a refusal lands on the row and the value reverts', async () => {
    updateIssueAction.mockResolvedValueOnce({
      ok: false,
      error: REFUSED,
      code: 'OBSOLESCENCE_REQUIRES_FINISHED',
    });
    renderQuickView();
    fireEvent.click(within(row('Obsolescence')).getByRole('button', { name: 'Edit Obsolescence' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Obsolescence' })).getByRole('button', {
          name: 'Outdated',
        }),
      );
    });
    await waitFor(() => expect(within(row('Obsolescence')).getByText(REFUSED)).toBeTruthy());
    expect(within(row('Obsolescence')).getByText('Current')).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });
});

// ── MOTIR-6676 — the status control on a MARKED card ────────────────────────────

const HELD_TEXT = 'Status can’t be reopened while this item is marked Outdated.';

/** Open the item page's Status picker. */
function openStatus() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit Status' }));
  if (!screen.queryByRole('option', { name: /To Do/ }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
}

function notice() {
  return screen.queryByTestId('status-held-notice');
}

describe('item page — the status control holds a marked card', () => {
  it('holds To Do by mark with the line and its door; Cancelled stays pickable', () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }));
    expect(notice()!.textContent).toContain(HELD_TEXT);
    openStatus();
    const todo = screen.getByRole('option', { name: /To Do/ });
    expect(todo.getAttribute('aria-disabled')).toBe('true');
    expect(todo.textContent).toContain('held by mark');
    expect(
      screen.getByRole('option', { name: /Cancelled/ }).getAttribute('aria-disabled'),
    ).not.toBe('true');
  });

  it('Clear the mark goes to the field on this page and leaves the mark set', () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }));
    card().scrollIntoView = vi.fn();
    fireEvent.click(within(notice()!).getByRole('link', { name: 'Clear the mark' }));
    expect(document.activeElement).toBe(card());
    expect(updateIssueAction).not.toHaveBeenCalled();
    expect(card().querySelector('[data-obsolescence="outdated"]')).toBeTruthy();
  });

  it('clearing the mark in the field lifts the hold with no reload', async () => {
    renderPanel(makeItem({ obsolescence: 'outdated' }));
    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Current' }));
    });
    expect(notice()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    openStatus();
    expect(screen.getByRole('option', { name: /To Do/ }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('a MARKED_CARD_CANNOT_REOPEN refusal reverts and draws the line — no toast', async () => {
    changeStatusAction.mockResolvedValueOnce({
      ok: false,
      error: 'marked',
      field: 'status',
      code: 'MARKED_CARD_CANNOT_REOPEN',
      mark: 'deprecated',
    });
    renderPanel(makeItem());
    expect(notice()).toBeNull();
    openStatus();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /To Do/ }));
    });
    expect(notice()!.textContent).toContain(
      'Marked Deprecated elsewhere — this move was not made.',
    );
    expect(toast).not.toHaveBeenCalled();
    const statusCard = screen
      .getByRole('button', { name: 'Edit Status' })
      .closest('[data-surface="card"]')!;
    expect(statusCard.textContent).toContain('Done');
  });
});

describe('quick view — the status control holds a marked card', () => {
  it('draws the line under Status, its door pointing at the peek’s own field', () => {
    renderQuickView({ obsolescence: 'outdated' });
    const box = notice()!;
    expect(box.textContent).toContain(HELD_TEXT);
    const field = document.getElementById('obsolescence-field-peek')!;
    field.scrollIntoView = vi.fn();
    fireEvent.click(within(box).getByRole('link', { name: 'Clear the mark' }));
    expect(document.activeElement).toBe(field);
  });

  it('a refusal folds in on the rail — no row error, no toast', async () => {
    changeStatusAction.mockResolvedValueOnce({
      ok: false,
      error: 'marked',
      field: 'status',
      code: 'MARKED_CARD_CANNOT_REOPEN',
      mark: 'outdated',
    });
    renderQuickView();
    fireEvent.click(within(row('Status')).getByRole('button', { name: 'Edit Status' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /To Do/ }));
    });
    await waitFor(() =>
      expect(notice()!.textContent).toContain(
        'Marked Outdated elsewhere — this move was not made.',
      ),
    );
    expect(within(row('Status')).queryByText('marked')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

// Found by MOTIR-6680's recording: the header badge is a DIFFERENT surface from the
// rail and the rail never refreshes on success, so the page carries the mark to it
// through `OptimisticMarkProvider`.
describe('the item page header follows the rail’s write, with no refresh', () => {
  it('marking shows the header badge; clearing takes it away', async () => {
    const item = makeItem();
    renderWithIntl(
      <OptimisticMarkProvider serverMark={item.obsolescence}>
        <OptimisticObsolescenceHeaderLink serverMark={item.obsolescence} />
        <CoreFieldsPanel item={item} members={[]} workflow={workflow} parent={null} />
      </OptimisticMarkProvider>,
      { messages: EN, locale: 'en' },
    );
    const link = () => document.querySelector('[data-obsolescence-link]');
    expect(link()).toBeNull();

    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Outdated' }));
    });
    expect(link()?.getAttribute('data-obsolescence-link')).toBe('outdated');

    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Current' }));
    });
    expect(link()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('clearing a mark the SERVER rendered takes the badge away (a null is not "no channel")', async () => {
    const item = makeItem({ obsolescence: 'deprecated' });
    renderWithIntl(
      <OptimisticMarkProvider serverMark="deprecated">
        <OptimisticObsolescenceHeaderLink serverMark="deprecated" />
        <CoreFieldsPanel item={item} members={[]} workflow={workflow} parent={null} />
      </OptimisticMarkProvider>,
      { messages: EN, locale: 'en' },
    );
    expect(document.querySelector('[data-obsolescence-link="deprecated"]')).toBeTruthy();
    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Current' }));
    });
    expect(document.querySelector('[data-obsolescence-link]')).toBeNull();
  });

  it('a refused write leaves the header as it was', async () => {
    updateIssueAction.mockResolvedValueOnce({
      ok: false,
      error: REFUSED,
      code: 'OBSOLESCENCE_REQUIRES_FINISHED',
    });
    const item = makeItem();
    renderWithIntl(
      <OptimisticMarkProvider serverMark={null}>
        <OptimisticObsolescenceHeaderLink serverMark={null} />
        <CoreFieldsPanel item={item} members={[]} workflow={workflow} parent={null} />
      </OptimisticMarkProvider>,
      { messages: EN, locale: 'en' },
    );
    const group = openCardEditor();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Deprecated' }));
    });
    expect(document.querySelector('[data-obsolescence-link]')).toBeNull();
  });
});
