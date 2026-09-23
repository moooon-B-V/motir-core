// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { QuickViewData } from '@/lib/dto/quickView';

// Story MOTIR-6016 · MOTIR-6101 — a leaf's DIFFICULTY on the item page's core
// fields rail AND in the quick view, per
// design/work-items/core-fields--difficulty.mock.html: unset / each value /
// the Segmented editor + Clear / read-only / ABSENT on an epic or story, and
// every change saved through `updateIssueAction`.

const { updateIssueAction, refresh } = vi.hoisted(() => ({
  updateIssueAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction,
  changeStatusAction: vi.fn(),
  getWorkItemPlacementAction: vi.fn(),
  fileWorkItemAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
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

// The field's strings, merged over the real catalogues (a no-op once they ship).
type Catalog = Record<string, Record<string, unknown>>;
function withDifficulty(base: unknown, s: Record<string, string>): Record<string, unknown> {
  const m = structuredClone(base) as Catalog;
  m.issueViews = { ...m.issueViews, difficulty: s.label, setDifficulty: s.set };
  m.ui = {
    ...m.ui,
    difficultyPicker: {
      ...((m.ui?.difficultyPicker as object) ?? {}),
      label: s.label,
      clear: s.clear,
    },
  };
  return m;
}
const EN = withDifficulty(enMessages, {
  label: 'Difficulty',
  set: 'Set difficulty',
  clear: 'Clear',
});
const ZH = withDifficulty(zhMessages, { label: '难度', set: '设置难度', clear: '清除' });

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
  ],
  transitions: [],
  policyMode: 'open',
};

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'p1',
    parentId: null,
    kind: 'subtask',
    key: 7,
    identifier: 'PROD-7',
    title: 'Reorder the lock acquisition',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
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

/** The rail card whose caption is `label`. */
function card(label: string) {
  return screen.getAllByText(label, { selector: 'div' })[0]!.parentElement!.parentElement!;
}

beforeEach(() => {
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-09-03T00:00:00.000Z' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('item page — the Difficulty card', () => {
  it('shows the dashed Set difficulty affordance on an unset leaf, even with no type', () => {
    renderPanel(makeItem());
    expect(within(card('Difficulty')).getByRole('button', { name: 'Set difficulty' })).toBeTruthy();
  });

  it.each([
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ] as const)('renders %s as a plain label with a faint glyph — no pill', (value, text) => {
    renderPanel(makeItem({ difficulty: value }));
    const c = card('Difficulty');
    const indicator = c.querySelector('[data-difficulty]')!;
    expect(indicator.getAttribute('data-difficulty')).toBe(value);
    expect(indicator.textContent).toBe(text);
    expect(indicator.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.querySelector('svg')!.getAttribute('class')).toContain('--el-text-faint');
  });

  it('sets a value through the Segmented and saves it through updateIssueAction', async () => {
    renderPanel(makeItem());
    fireEvent.click(within(card('Difficulty')).getByRole('button', { name: 'Set difficulty' }));
    const group = screen.getByRole('group', { name: 'Difficulty' });
    // Unset: nothing pressed, and nothing to clear yet.
    expect(
      within(group)
        .getAllByRole('button')
        .every((b) => b.getAttribute('aria-pressed') === 'false'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Medium' }));
    });
    await waitFor(() =>
      expect(updateIssueAction).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi_1', difficulty: 'medium' }),
      ),
    );
    // The optimistic value stands — the 200 is the confirmation, no refresh.
    expect(card('Difficulty').querySelector('[data-difficulty]')!.textContent).toBe('Medium');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('changes one value to another', async () => {
    renderPanel(makeItem({ difficulty: 'medium' }));
    fireEvent.click(within(card('Difficulty')).getByRole('button', { name: 'Edit Difficulty' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Difficulty' })).getByRole('button', {
          name: 'High',
        }),
      );
    });
    expect(updateIssueAction).toHaveBeenCalledWith(expect.objectContaining({ difficulty: 'high' }));
  });

  it('Clear saves null and returns the card to Set difficulty', async () => {
    renderPanel(makeItem({ difficulty: 'low' }));
    fireEvent.click(within(card('Difficulty')).getByRole('button', { name: 'Edit Difficulty' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    expect(updateIssueAction).toHaveBeenCalledWith(expect.objectContaining({ difficulty: null }));
    expect(within(card('Difficulty')).getByRole('button', { name: 'Set difficulty' })).toBeTruthy();
  });

  it('a read-only viewer sees the value with no chevron and no picker', () => {
    renderPanel(makeItem({ difficulty: 'high' }), { readOnly: true });
    const c = card('Difficulty');
    expect(c.querySelector('[data-difficulty]')!.textContent).toBe('High');
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('a read-only viewer of an unset leaf sees None, not the Set affordance', () => {
    renderPanel(makeItem(), { readOnly: true });
    const c = card('Difficulty');
    expect(within(c).getByText('None')).toBeTruthy();
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it.each(['epic', 'story'] as const)('renders NO Difficulty card on an %s', (kind) => {
    renderPanel(makeItem({ kind: kind as WorkItemKindDto, parentId: null }));
    expect(screen.queryByText('Difficulty')).toBeNull();
    expect(screen.queryByRole('button', { name: /difficulty/i })).toBeNull();
  });

  it('renders in zh', () => {
    renderPanel(makeItem({ difficulty: 'high' }), { messages: ZH, locale: 'zh' });
    expect(screen.getAllByText('难度', { selector: 'div' }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-difficulty]')!.textContent).toBe('高');
  });
});

// ── The quick view ─────────────────────────────────────────────────────────────

const DATA: QuickViewData = {
  folderId: null,
  folderPath: [],
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Reorder the lock acquisition',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: null,
  explanationMd: null,
  type: null,
  executor: null,
  difficulty: null,
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
  status: 'todo',
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

function renderQuickView(
  data: Partial<QuickViewData> = {},
  { readOnly = false, messages = EN, locale = 'en' } = {},
) {
  const tree = <IssueQuickViewPanel state="ready" data={{ ...DATA, ...data }} />;
  return renderWithIntl(
    readOnly ? <ProjectAccessProvider permissions={[]}>{tree}</ProjectAccessProvider> : tree,
    { messages, locale },
  );
}

/** The rail row whose caption is `label`. */
function row(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement as HTMLElement;
}

describe('quick view — the Difficulty rail field', () => {
  it('reads None when unset', () => {
    renderQuickView();
    expect(within(row('Difficulty')).getByText('None')).toBeTruthy();
  });

  it.each([
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ] as const)('reads %s as a label with a faint glyph', (value, text) => {
    renderQuickView({ difficulty: value });
    const indicator = row('Difficulty').querySelector('[data-difficulty]')!;
    expect(indicator.textContent).toBe(text);
  });

  it('sets, then clears, through updateIssueAction — the optimistic value shows at once', async () => {
    renderQuickView();
    fireEvent.click(within(row('Difficulty')).getByRole('button', { name: 'Edit Difficulty' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Difficulty' })).getByRole('button', {
          name: 'High',
        }),
      );
    });
    expect(updateIssueAction).toHaveBeenCalledWith(expect.objectContaining({ difficulty: 'high' }));
    expect(row('Difficulty').querySelector('[data-difficulty]')!.textContent).toBe('High');

    fireEvent.click(within(row('Difficulty')).getByRole('button', { name: 'Edit Difficulty' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    expect(updateIssueAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ difficulty: null }),
    );
    await waitFor(() => expect(within(row('Difficulty')).getByText('None')).toBeTruthy());
  });

  it('a read-only viewer sees the value and no edit affordance', () => {
    renderQuickView({ difficulty: 'medium' }, { readOnly: true });
    expect(row('Difficulty').querySelector('[data-difficulty]')!.textContent).toBe('Medium');
    expect(within(row('Difficulty')).queryByRole('button')).toBeNull();
  });

  it.each(['epic', 'story'] as const)('renders NO Difficulty row on an %s', (kind) => {
    renderQuickView({ kind, type: null });
    expect(screen.queryByText('Difficulty', { selector: 'dt' })).toBeNull();
  });

  it('renders in zh', () => {
    renderQuickView({ difficulty: 'low' }, { messages: ZH, locale: 'zh' });
    expect(row('难度').querySelector('[data-difficulty]')!.textContent).toBe('低');
  });
});
