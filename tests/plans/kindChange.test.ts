import { describe, expect, it } from 'vitest';
import {
  assertAddKindPlacementLegal,
  validatePlanProposals,
  type KindChangeContext,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import {
  assertReKindedAddKeepsNoLeafFields,
  validateProposedKindChange,
} from '@/lib/plans/validateProposedKind';
import { InvalidProposalError, PlanGrammarError } from '@/lib/plans/errors';
import { MODIFY_KIND_TARGETS, PLAN_ITEM_PATCH_KEYS } from '@/lib/dto/plans';
import { assertKnownPatchKeys } from '@/lib/plans/validatePatchKeys';

// Bug MOTIR-8192 — a plan `modify` could not change a committed card's KIND.
//
// ── The reproduction ───────────────────────────────────────────────────────
// `PLAN_ITEM_PATCH_KEYS` had no `kind`, so `assertKnownPatchKeys` refused
// `patch.kind` at the append (the first `it` below states the fix as that check
// passing). The only door was `change_kind`, outside the plan a person approves.
//
// ── What this file pins (pure, no DB) ──────────────────────────────────────
// The re-kind gate `validatePlanProposals` runs at the close and at approve, and
// the add-side placement check the correction and the deepen run. The service
// and the database are `tests/integration/plans/planModifyKindChange.test.ts`.

const EPIC = 'wi_epic';
const TARGET = 'wi_target';
const PROJECT = 'proj_plan';

function live(id: string, kind: string): LiveWorkItemState {
  return { id, kind, status: 'todo', projectId: PROJECT, key: `PROD-${id}`, title: `The ${id}` };
}

function modify(
  id: string,
  workItemId: string,
  patch: NonNullable<ProposalNode['patch']>,
): ProposalNode {
  return {
    id,
    op: 'modify',
    workItemId,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: null,
    patch,
  };
}

function add(id: string, kind: string, parentRef: string | null): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef,
    blockedByRefs: [],
    proposedFields: { kind, title: `Proposed ${id}` },
    patch: null,
  };
}

/** A committed `task` under an epic, typed and judged, with two subtask children. */
function taskContext(overrides: Partial<KindChangeContext> = {}): KindChangeContext {
  return {
    parentId: EPIC,
    parentKind: 'epic',
    filed: false,
    type: 'code',
    difficulty: 'medium',
    children: [
      { id: 'wi_s1', key: 'PROD-11', title: 'First step', kind: 'subtask' },
      { id: 'wi_s2', key: 'PROD-12', title: 'Second step', kind: 'subtask' },
    ],
    ...overrides,
  };
}

function run(
  items: ProposalNode[],
  opts: {
    liveById?: Map<string, LiveWorkItemState>;
    contexts?: Map<string, KindChangeContext>;
  } = {},
): void {
  const liveById =
    opts.liveById ?? new Map([live(EPIC, 'epic'), live(TARGET, 'task')].map((l) => [l.id, l]));
  validatePlanProposals({
    items,
    liveById,
    terminalStatusKeys: new Set(['done', 'cancelled']),
    planProjectId: PROJECT,
    ancestorIdsById: new Map(),
    existingBlockedByEdges: [],
    existingSupersedesEdges: [],
    markTargetStatusCategoryById: new Map(),
    kindChangeContextById: opts.contexts ?? new Map([[TARGET, taskContext()]]),
  });
}

function reasonOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(PlanGrammarError);
    return (err as PlanGrammarError).reason;
  }
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('`patch.kind` is a patch key a `modify` can carry', () => {
  it('passes the unknown-key check that used to refuse it — the reproduction, inverted', () => {
    expect(PLAN_ITEM_PATCH_KEYS).toContain('kind');
    expect(() => assertKnownPatchKeys({ kind: 'story' }, 'Proposal m1')).not.toThrow();
  });

  it('accepts the four re-kind targets and refuses `epic` and anything else, by name', () => {
    for (const kind of MODIFY_KIND_TARGETS) {
      expect(() => validateProposedKindChange(kind, 'Proposal m1')).not.toThrow();
    }
    expect(() => validateProposedKindChange(undefined, 'Proposal m1')).not.toThrow();
    expect(() => validateProposedKindChange('epic', 'Proposal m1')).toThrow(InvalidProposalError);
    expect(messageOf(() => validateProposedKindChange('epic', 'Proposal m1'))).toContain(
      'cannot be `epic`',
    );
    for (const bad of ['feature', null, 7]) {
      expect(() => validateProposedKindChange(bad, 'Proposal m1')).toThrow(InvalidProposalError);
    }
  });
});

describe('validatePlanProposals — a `modify` re-kinding its target (MOTIR-8192)', () => {
  it('the card’s case: a task with subtask children becomes a story when the patch clears its leaf fields', () => {
    expect(
      reasonOf(() => run([modify('m1', TARGET, { kind: 'story', type: null, difficulty: null })])),
    ).toBeNull();
  });

  it('refuses `epic` (and any non-member) with `unknown_kind`', () => {
    expect(reasonOf(() => run([modify('m1', TARGET, { kind: 'epic' })]))).toBe('unknown_kind');
    expect(reasonOf(() => run([modify('m1', TARGET, { kind: 'feature' })]))).toBe('unknown_kind');
  });

  it('refuses a kind the target’s PARENT does not admit', () => {
    // A task under a STORY cannot become a story (a story's parent is an epic).
    const contexts = new Map([
      [TARGET, taskContext({ parentId: 'wi_story', parentKind: 'story', children: [] })],
    ]);
    const fn = () =>
      run([modify('m1', TARGET, { kind: 'story', type: null, difficulty: null })], { contexts });
    expect(reasonOf(fn)).toBe('illegal_parent');
    expect(messageOf(fn)).toContain('current parent');
  });

  it('refuses a kind that cannot parent a child the target KEEPS, naming the child', () => {
    // A story with a task child cannot become a task (a task parents no task).
    const contexts = new Map([
      [
        TARGET,
        taskContext({
          type: null,
          difficulty: null,
          children: [{ id: 'wi_c', key: 'PROD-21', title: 'Child task', kind: 'task' }],
        }),
      ],
    ]);
    const liveById = new Map([live(EPIC, 'epic'), live(TARGET, 'story')].map((l) => [l.id, l]));
    const fn = () => run([modify('m1', TARGET, { kind: 'task' })], { contexts, liveById });
    expect(reasonOf(fn)).toBe('illegal_parent');
    expect(messageOf(fn)).toContain('PROD-21');

    // …unless the same plan MOVES that child away, or re-kinds it to a kind the
    // new kind admits.
    const movedAway = modify('m2', 'wi_c', { parentRef: null });
    const liveWithChild = new Map(liveById).set('wi_c', live('wi_c', 'task'));
    expect(
      reasonOf(() =>
        run([modify('m1', TARGET, { kind: 'task' }), movedAway], {
          contexts,
          liveById: liveWithChild,
        }),
      ),
    ).toBeNull();
    expect(
      reasonOf(() =>
        run([modify('m1', TARGET, { kind: 'task' }), modify('m2', 'wi_c', { kind: 'subtask' })], {
          contexts: new Map([
            ...contexts,
            [
              'wi_c',
              taskContext({
                parentId: TARGET,
                parentKind: 'story',
                type: null,
                difficulty: null,
                children: [],
              }),
            ],
          ]),
          liveById: liveWithChild,
        }),
      ),
    ).toBeNull();
  });

  it('refuses a container keeping the target’s TYPE or DIFFICULTY — refused, never cleared', () => {
    expect(reasonOf(() => run([modify('m1', TARGET, { kind: 'story', difficulty: null })]))).toBe(
      'type_on_container',
    );
    expect(reasonOf(() => run([modify('m1', TARGET, { kind: 'story', type: null })]))).toBe(
      'difficulty_on_container',
    );
    // A container carrying a type the PATCH sets is refused the same way.
    expect(
      reasonOf(() =>
        run([modify('m1', TARGET, { kind: 'story', type: 'code', difficulty: null })]),
      ),
    ).toBe('type_on_container');
    // A leaf → leaf re-kind keeps its leaf fields, legally.
    expect(reasonOf(() => run([modify('m1', TARGET, { kind: 'bug' })]))).toBeNull();
  });

  it('judges the plan’s own placements under the target against its PROJECTED kind', () => {
    const contexts = new Map([[TARGET, taskContext({ children: [] })]]);
    // A task under a TASK is illegal…
    expect(reasonOf(() => run([add('a1', 'task', TARGET)], { contexts }))).toBe('illegal_parent');
    // …and legal under the story the same plan turns that task into.
    expect(
      reasonOf(() =>
        run(
          [
            modify('m1', TARGET, { kind: 'story', type: null, difficulty: null }),
            add('a1', 'task', TARGET),
          ],
          { contexts },
        ),
      ),
    ).toBeNull();
  });

  it('a FILED target may become a subtask; an unfiled root may not', () => {
    const root = (filed: boolean) =>
      new Map([[TARGET, taskContext({ parentId: null, parentKind: null, filed, children: [] })]]);
    expect(
      reasonOf(() => run([modify('m1', TARGET, { kind: 'subtask' })], { contexts: root(true) })),
    ).toBeNull();
    expect(
      reasonOf(() => run([modify('m1', TARGET, { kind: 'subtask' })], { contexts: root(false) })),
    ).toBe('illegal_parent');
  });

  it('with no context for the target, judges membership only — the permissive answer', () => {
    expect(
      reasonOf(() => run([modify('m1', TARGET, { kind: 'story' })], { contexts: new Map() })),
    ).toBeNull();
  });
});

describe('an `add` whose kind a door changes (MOTIR-8192, case B)', () => {
  it('refuses a container keeping a `type` or an `executor`, by name', () => {
    expect(() =>
      assertReKindedAddKeepsNoLeafFields('story', { type: 'code' }, 'Proposal a1'),
    ).toThrow(InvalidProposalError);
    expect(
      messageOf(() =>
        assertReKindedAddKeepsNoLeafFields(
          'story',
          { type: 'code', executor: 'coding_agent' },
          'Proposal a1',
        ),
      ),
    ).toContain('`type` and `executor`');
    expect(() =>
      assertReKindedAddKeepsNoLeafFields('story', { type: null, executor: null }, 'Proposal a1'),
    ).not.toThrow();
    expect(() =>
      assertReKindedAddKeepsNoLeafFields('bug', { type: 'code' }, 'Proposal a1'),
    ).not.toThrow();
  });

  it('checks the add’s own parent and every proposal hung under it', () => {
    const story = live('wi_story', 'story');
    const liveById = new Map([[story.id, story]]);
    const child = add('a2', 'subtask', 'planItem:a1');

    // Re-kinded to a story under a story: its parent refuses it.
    expect(
      reasonOf(() =>
        assertAddKindPlacementLegal('a1', [add('a1', 'story', story.id), child], liveById),
      ),
    ).toBe('illegal_parent');
    // Re-kinded to a subtask: it cannot parent its own subtask child.
    const fn = () =>
      assertAddKindPlacementLegal('a1', [add('a1', 'subtask', story.id), child], liveById);
    expect(reasonOf(fn)).toBe('illegal_parent');
    expect(messageOf(fn)).toContain('Proposed a2');
    // Re-kinded to a bug: legal on both sides.
    expect(
      reasonOf(() =>
        assertAddKindPlacementLegal('a1', [add('a1', 'bug', story.id), child], liveById),
      ),
    ).toBeNull();
  });
});
