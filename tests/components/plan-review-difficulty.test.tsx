// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { changedFields } from '@/lib/planning/planChangeDiff';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// Story MOTIR-6095 · MOTIR-6137 — the plan review renders a leaf's DIFFICULTY,
// built to `design/ai-planning/plan-review--difficulty.mock.html` and
// `design-notes.md` Part XX (§20.3–§20.7). One file per surface the design draws:
// the canvas card, the list row, the peek's rail, and the change frame's chip.
// The value the review model carries is asserted against the real service in
// `tests/integration/plans/planReviewDifficulty.test.ts`; this file drives the
// renderers off that shape.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { ProposalPeek } from '@/components/planning/ProposalPeek';

const EN_LABEL: Record<WorkItemDifficultyDto, string> = enMessages.labels.difficulty;

function addLeaf(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_add',
    op: 'add',
    kind: 'subtask',
    type: 'code',
    title: 'Sign the webhook payload',
    storyPoints: 3,
    estimateMinutes: 45,
    targetRepo: 'motir-core',
    ...over,
    proposal: {
      op: 'add',
      identifier: null,
      changedFields: [],
      settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
      todos: null,
    },
  });
}

function modifyLeaf(
  changes: PlanItemChangeDto[],
  over: Partial<PlanReviewItemDto> = {},
): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_mod',
    op: 'modify',
    identifier: 'PROD-14',
    kind: 'subtask',
    type: 'code',
    title: 'Sign the webhook payload',
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    changes,
    ...over,
    proposal: {
      op: 'modify',
      identifier: 'PROD-14',
      changedFields: changes.map(
        (c) => c.field as PlanReviewItemDto['proposal']['changedFields'][number],
      ),
      settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
      todos: null,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── The canvas card (§20.3, §20.4, §20.5, §20.6) ────────────────────────────

describe('the canvas card', () => {
  it.each(WORK_ITEM_DIFFICULTIES)(
    'an `add` leaf carrying `%s` shows its glyph and label at the right end of the top row',
    (difficulty) => {
      render(<PlanItemNode item={addLeaf({ difficulty })} />);
      const value = screen.getByTestId('plan-item-difficulty');
      expect(value.getAttribute('data-difficulty')).toBe(difficulty);
      // Named for a screen reader — "Difficulty Medium", never a bare "Medium".
      expect(value.textContent).toBe(`Difficulty ${EN_LABEL[difficulty]}`);
      expect(value.querySelector('.sr-only')?.textContent?.trim()).toBe('Difficulty');
      // The glyph is decorative, faint, at the card's 12px size.
      const glyph = value.querySelector('svg')!;
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.getAttribute('class')).toContain('h-3 w-3');
      expect(glyph.getAttribute('class')).toContain('text-(--el-text-faint)');
      // The LABEL ink is secondary — AA on the add frame's lavender tint.
      expect(value.className).toContain('text-(--el-text-secondary)');
      expect(value.className).not.toContain('text-(--el-text-muted)');
      // In the top row, never the bottom slot: the title keeps its two lines.
      const node = screen.getByTestId('plan-item-node');
      expect(node.firstElementChild?.contains(value)).toBe(true);
      expect(screen.queryByTestId('diff-line')).toBeNull();
    },
  );

  it('an `add` leaf with NO difficulty draws nothing in the slot', () => {
    render(<PlanItemNode item={addLeaf({ difficulty: null })} />);
    expect(screen.queryByTestId('plan-item-difficulty')).toBeNull();
    expect(screen.getByTestId('plan-item-node').textContent).not.toContain('None');
  });

  it('a `modify` card shows only its diff line — never the value in its top row', () => {
    render(
      <PlanItemNode
        item={modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }], {
          difficulty: 'high',
        })}
      />,
    );
    expect(screen.queryByTestId('plan-item-difficulty')).toBeNull();
    const line = screen.getByTestId('diff-line');
    // The item page's LABELS, never the wire words.
    expect(line.textContent).toBe('DifficultyLowHigh');
    expect(within(line).getByText('Low').className).toContain('line-through');
  });

  it('a `modify` that SETS a difficulty draws no from side', () => {
    render(
      <PlanItemNode
        item={modifyLeaf([{ field: 'difficulty', from: null, to: 'medium' }], {
          difficulty: 'medium',
        })}
      />,
    );
    expect(screen.getByTestId('diff-line').textContent).toBe('DifficultyMedium');
  });

  it('a `modify` that CLEARS it reads Medium → —', () => {
    render(<PlanItemNode item={modifyLeaf([{ field: 'difficulty', from: 'medium', to: null }])} />);
    expect(screen.getByTestId('diff-line').textContent).toBe('DifficultyMedium—');
  });

  it('reads Low → High in zh too', () => {
    render(
      <PlanItemNode
        item={modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }], {
          difficulty: 'high',
        })}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('diff-line').textContent).toBe(
      `${zhMessages.planReview.field_difficulty}${zhMessages.labels.difficulty.low}${zhMessages.labels.difficulty.high}`,
    );
  });

  it.each(['epic', 'story'])('a %s proposal draws no difficulty on the card', (kind) => {
    // A container cannot carry one (MOTIR-6133 refuses it). Even a model that
    // somehow did is not drawn: the design gives a container no affordance.
    render(<PlanItemNode item={addLeaf({ kind, difficulty: 'high' })} />);
    expect(screen.queryByTestId('plan-item-difficulty')).toBeNull();
  });
});

// ── The list row (§20.5, §20.7) ─────────────────────────────────────────────

describe('the list row', () => {
  it('puts the glyph and label directly after the points in the facts line', () => {
    render(<PlanProposalList items={[addLeaf({ difficulty: 'medium' })]} outcome={null} />);
    const fact = screen.getByTestId('plan-list-difficulty');
    expect(fact.getAttribute('data-difficulty')).toBe('medium');
    expect(fact.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(fact.parentElement?.textContent).toBe(
      'subtask · code · 3 pts · Difficulty Medium · 45 min · motir-core',
    );
  });

  it('omits a missing value like every other empty fact', () => {
    render(<PlanProposalList items={[addLeaf({ difficulty: null })]} outcome={null} />);
    expect(screen.queryByTestId('plan-list-difficulty')).toBeNull();
    expect(screen.getByText('subtask · code · 3 pts · 45 min · motir-core')).toBeTruthy();
  });

  it('a container row carries none', () => {
    render(
      <PlanProposalList
        items={[addLeaf({ kind: 'story', type: null, difficulty: 'high' })]}
        outcome={null}
      />,
    );
    expect(screen.queryByTestId('plan-list-difficulty')).toBeNull();
  });

  it('a `modify` spells DIFFICULTY Low → High in its change grid, and carries the new value', () => {
    render(
      <PlanProposalList
        items={[
          modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }], {
            difficulty: 'high',
            storyPoints: 3,
          }),
        ]}
        outcome={null}
      />,
    );
    const term = screen.getByText('Difficulty', { selector: 'dt' });
    const cell = term.nextElementSibling as HTMLElement;
    expect(cell.textContent).toBe('Low→High');
    expect(within(cell).getByText('Low').className).toContain('line-through');
    // The facts line carries the value approve will WRITE.
    expect(screen.getByTestId('plan-list-difficulty').getAttribute('data-difficulty')).toBe('high');
  });

  it('a cleared value reads — in the grid and is omitted from the facts line', () => {
    render(
      <PlanProposalList
        items={[
          modifyLeaf([{ field: 'difficulty', from: 'medium', to: null }], { difficulty: null }),
        ]}
        outcome={null}
      />,
    );
    const cell = screen.getByText('Difficulty', { selector: 'dt' }).nextElementSibling!;
    expect(cell.textContent).toBe('Medium→—');
    expect(screen.queryByTestId('plan-list-difficulty')).toBeNull();
  });

  it('a `modify` whose patch has no difficulty key shows no difficulty row', () => {
    render(
      <PlanProposalList
        items={[
          modifyLeaf([{ field: 'storyPoints', from: '3', to: '5' }], {
            difficulty: 'low',
            storyPoints: 5,
          }),
        ]}
        outcome={null}
      />,
    );
    expect(screen.queryByText('Difficulty', { selector: 'dt' })).toBeNull();
  });

  it('reads the zh grid in zh', () => {
    render(
      <PlanProposalList
        items={[
          modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }], { difficulty: 'high' }),
        ]}
        outcome={null}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    const cell = screen.getByText(zhMessages.planReview.field_difficulty, {
      selector: 'dt',
    }).nextElementSibling!;
    expect(cell.textContent).toBe('低→高');
  });
});

// ── The peek's rail (§20.4, §20.5, §20.6) ───────────────────────────────────

const TARGET_PAYLOAD: Partial<QuickViewData> = {
  folderId: null,
  folderPath: [],
  id: 'wi_14',
  identifier: 'PROD-14',
  title: 'Sign the webhook payload',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: null,
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  difficulty: 'low',
  assigneeName: null,
  assigneeId: null,
  reporterName: 'Zhu Yue',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  dueDate: null,
  sprintName: null,
  sprintId: null,
  storyPoints: 3,
  estimateMinutes: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archived: null,
  parent: null,
  parentId: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: false,
  workflow: { statuses: [], transitions: [], policyMode: 'open' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    canEdit: false,
  },
};

/** The rail row whose term is `Difficulty`, or null when the rail has none. */
function difficultyRow(peek: HTMLElement): { term: HTMLElement; value: HTMLElement } | null {
  const term = Array.from(peek.querySelectorAll('dt')).find((dt) =>
    (dt.textContent ?? '').startsWith('Difficulty'),
  );
  if (!term) return null;
  return { term: term as HTMLElement, value: term.nextElementSibling as HTMLElement };
}

describe('the peek', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => TARGET_PAYLOAD })),
    );
  });

  it.each(WORK_ITEM_DIFFICULTIES)('an `add` carrying `%s` shows its glyph and label', (d) => {
    render(<ProposalPeek item={addLeaf({ difficulty: d })} onClose={() => {}} />);
    const row = difficultyRow(screen.getByTestId('proposal-peek'))!;
    expect(row).not.toBeNull();
    expect(row.value.textContent).toBe(EN_LABEL[d]);
    expect(row.value.querySelector(`[data-difficulty="${d}"] svg`)).not.toBeNull();
    // An `add` moves nothing, so no row carries the changed mark.
    expect(within(row.term).queryByText('changed')).toBeNull();
  });

  it('an `add` carrying none shows the quick view’s own None', () => {
    render(<ProposalPeek item={addLeaf({ difficulty: null })} onClose={() => {}} />);
    const row = difficultyRow(screen.getByTestId('proposal-peek'))!;
    expect(row.value.textContent).toBe('None');
  });

  it.each(['epic', 'story'])('a %s proposal has no Difficulty row', (kind) => {
    render(
      <ProposalPeek item={addLeaf({ kind, type: null, difficulty: null })} onClose={() => {}} />,
    );
    expect(difficultyRow(screen.getByTestId('proposal-peek'))).toBeNull();
  });

  it('a `modify` lays the new value over the target, marks it changed, and counts 1 of 7', async () => {
    render(
      <ProposalPeek
        item={modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }], {
          difficulty: 'high',
          storyPoints: 3,
        })}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const peek = screen.getByTestId('proposal-peek');
    const row = difficultyRow(peek)!;
    // The value approve will WRITE, not the target's `low`.
    expect(row.value.textContent).toBe('High');
    expect(within(row.term).getByText('changed')).toBeTruthy();
    expect(peek.textContent).toContain('This plan changes 1 of the 7 fields it can set.');
  });

  it('a `modify` that CLEARS it reads None, marked changed', async () => {
    render(
      <ProposalPeek
        item={modifyLeaf([{ field: 'difficulty', from: 'low', to: null }], { difficulty: null })}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const row = difficultyRow(screen.getByTestId('proposal-peek'))!;
    expect(row.value.textContent).toBe('None');
    expect(within(row.term).getByText('changed')).toBeTruthy();
  });

  it('a `modify` that does not touch it keeps the target’s value, unmarked', async () => {
    render(
      <ProposalPeek
        item={modifyLeaf([{ field: 'storyPoints', from: '3', to: '5' }], {
          difficulty: 'low',
          storyPoints: 5,
        })}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const row = difficultyRow(screen.getByTestId('proposal-peek'))!;
    expect(row.value.textContent).toBe('Low');
    expect(within(row.term).queryByText('changed')).toBeNull();
  });

  it('opens from the list row with the same value (the list door)', async () => {
    render(<PlanProposalList items={[addLeaf({ difficulty: 'trivial' })]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    expect(difficultyRow(screen.getByTestId('proposal-peek'))!.value.textContent).toBe('Trivial');
  });
});

// ── The planning workspace's change frame (§20.8, sheet 5) ─────────────────

describe('the change frame chip', () => {
  it('names the field `difficulty`', () => {
    const item = modifyLeaf([{ field: 'difficulty', from: 'low', to: 'high' }]);
    expect(changedFields(item)).toEqual(['difficulty']);
    expect(enMessages.planningWorkspace.conversation.diff.field.difficulty).toBe('difficulty');
    expect(zhMessages.planningWorkspace.conversation.diff.field.difficulty).toBe('难度');
  });
});

describe('the DifficultyIndicator itself (the compact form the review composes)', () => {
  it('draws the compact form with no host class, named for a screen reader', async () => {
    const { DifficultyIndicator } = await import('@/components/issues/DifficultyPicker');
    render(<DifficultyIndicator difficulty="high" compact={{ srLabel: 'Difficulty' }} />);
    const node = document.querySelector('[data-difficulty="high"]')!;
    expect(node.getAttribute('class')).toBe('inline-flex shrink-0 items-center gap-1');
    expect(node.getAttribute('data-testid')).toBeNull();
    expect(node.textContent).toBe(`Difficulty ${EN_LABEL.high}`);
  });

  it('appends the host class and test id when the caller gives them', async () => {
    const { DifficultyIndicator } = await import('@/components/issues/DifficultyPicker');
    render(
      <DifficultyIndicator
        difficulty="trivial"
        compact={{ srLabel: 'Difficulty', className: 'align-top', testId: 'probe' }}
      />,
    );
    const node = screen.getByTestId('probe');
    expect(node.className).toBe('inline-flex shrink-0 items-center gap-1 align-top');
    expect(node.getAttribute('data-difficulty')).toBe('trivial');
  });

  it('keeps the full item-page form when not compact — no screen-reader prefix', async () => {
    const { DifficultyIndicator } = await import('@/components/issues/DifficultyPicker');
    render(<DifficultyIndicator difficulty="low" />);
    const node = document.querySelector('[data-difficulty="low"]')!;
    expect(node.className).toBe('flex items-center gap-1.5');
    expect(node.textContent).toBe(EN_LABEL.low);
  });
});
