// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { QuickViewData } from '@/lib/dto/quickView';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';

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

  // MOTIR-6173 — the permission-gated rule's part 2: the chevron STAYS, disabled,
  // and says why; pressing it mounts no picker. (It used to be removed outright.)
  it('a read-only viewer sees the value and a DISABLED chevron that says why, and no picker', () => {
    renderPanel(makeItem({ difficulty: 'high' }), { readOnly: true });
    const c = card('Difficulty');
    expect(c.querySelector('[data-difficulty]')!.textContent).toBe('High');
    const chevron = within(c).getByRole('button', {
      name: 'Difficulty — You have read-only access to this project',
    });
    expect(chevron.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(chevron);
    expect(within(c).queryByRole('group')).toBeNull();
    expect(within(c).getAllByRole('button')).toHaveLength(1);
  });

  it('a read-only viewer of an unset leaf sees None, not the Set affordance', () => {
    renderPanel(makeItem(), { readOnly: true });
    const c = card('Difficulty');
    expect(within(c).getByText('None')).toBeTruthy();
    // No "Set difficulty" button — only the disabled chevron.
    expect(within(c).queryByRole('button', { name: /set difficulty/i })).toBeNull();
    expect(within(c).getByRole('button').getAttribute('aria-disabled')).toBe('true');
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

  it('a read-only viewer sees the value and a DISABLED chevron that says why (MOTIR-6173)', () => {
    renderQuickView({ difficulty: 'medium' }, { readOnly: true });
    expect(row('Difficulty').querySelector('[data-difficulty]')!.textContent).toBe('Medium');
    const chevron = within(row('Difficulty')).getByRole('button', {
      name: 'Difficulty — You have read-only access to this project',
    });
    expect(chevron.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(chevron);
    expect(within(row('Difficulty')).queryByRole('group')).toBeNull();
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

// ── MOTIR-6199 — the editor FITS its rail ───────────────────────────────────
// The scale gained a fourth level (`trivial`) in the implementation pull request
// itself, after MOTIR-6097's design was published, so the editor grew a fourth
// segment that no drawing had ever sized. The shipped `Segmented` track is
// `inline-flex` with no wrap, no `max-w-full` and no shrink — its width is
// `max-content` — inside a FIXED rail (18rem on the item page, 300px in the
// quick view), so the fourth segment painted over the card border.
//
// MOTIR-6200 settled the form: the track FILLS its rail and divides it evenly,
// and the leading glyph is dropped in the EDITOR only.
//
// ⚠️ WHY THIS ASSERTS THE VARIANT AND NOT A PIXEL COUNT. The app ships a SYSTEM
// font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`), so label
// advance differs per platform — and happy-dom performs no layout at all, so a
// width assertion here would measure nothing. The defect was never a particular
// number: it was that the track's width was a function of its CONTENT inside a
// container that could not grow. So the durable assertion is that the editor is
// the fill variant, which is container-relative by construction and therefore
// fits at any font, at any `--spacing-control-x`, and at a fifth level.
describe('the Difficulty editor fits its rail (MOTIR-6199)', () => {
  /** Open the item page's editor and hand back its Segmented track. */
  function openEditor() {
    renderPanel(makeItem({ difficulty: 'medium' }));
    fireEvent.click(within(card('Difficulty')).getByRole('button', { name: 'Edit Difficulty' }));
    return screen.getByRole('group', { name: 'Difficulty' });
  }

  it('renders one segment per member of the scale, so a fifth level needs no edit here', () => {
    expect(within(openEditor()).getAllByRole('button')).toHaveLength(WORK_ITEM_DIFFICULTIES.length);
  });

  it('fills the rail instead of sizing to its content — the track is not `inline-flex`', () => {
    const cls = openEditor().getAttribute('class') ?? '';
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('inline-flex');
  });

  it('lets every segment shrink evenly, so no segment can push the track past the rail', () => {
    for (const seg of within(openEditor()).getAllByRole('button')) {
      const cls = seg.getAttribute('class') ?? '';
      expect(cls).toContain('flex-1');
      expect(cls).toContain('min-w-0');
      // The per-style control padding is what made the track token-dependent:
      // `--spacing-control-x` is 10px, 12px or 14px depending on the style, so
      // at the widest one the content-sized track overran the rail by ~90px.
      expect(cls).not.toContain('px-(--spacing-control-x)');
    }
  });

  it('drops the leading glyph in the EDITOR — the labels alone carry the scale there', () => {
    expect(openEditor().querySelectorAll('svg')).toHaveLength(0);
  });

  it('KEEPS the glyph in read mode, where a lone value must not read as a priority', () => {
    renderPanel(makeItem({ difficulty: 'high' }));
    const indicator = card('Difficulty').querySelector('[data-difficulty]')!;
    expect(indicator.querySelector('svg')).toBeTruthy();
    expect(indicator.textContent).toBe('High');
  });

  it('still reaches every value, and Clear is still there once one is set', async () => {
    const group = openEditor();
    for (const label of ['Trivial', 'Low', 'Medium', 'High']) {
      expect(within(group).getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Trivial' }));
    });
    await waitFor(() =>
      expect(updateIssueAction).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi_1', difficulty: 'trivial' }),
      ),
    );
  });
});
