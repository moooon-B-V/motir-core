import { describe, expect, it } from 'vitest';
import {
  collectReferencedWorkItemIds,
  validatePlanProposals,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import { PlanGrammarError, PlanRefGraphError, PlanTargetImmutableError } from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';

// Subtask 7.12.5 / MOTIR-911 — the confirmation gate's VERDICT, as pure logic
// (no DB). The gate's job: an approved proposal set becomes rows ONLY after an
// independent re-validation, and a rejection happens before any write.
//
// These tests pin the verdict itself. `tests/integration/plans/approvePersistGate`
// proves the other half — that a rejection actually leaves Postgres untouched,
// and that the immutability verdict is re-taken under the row lock.
//
// The kind-parent expectations here are written INDEPENDENTLY of the matrix
// module (the same discipline tests/issues/parentValidation.test.ts uses), so
// these pin the CONTRACT rather than mirror the implementation.

const REAL_PARENT = 'wi_parent';
const REAL_TARGET = 'wi_target';

function live(overrides: Partial<LiveWorkItemState> & { id: string }): LiveWorkItemState {
  return { kind: 'story', status: 'todo', ...overrides };
}

function liveMap(...items: LiveWorkItemState[]): Map<string, LiveWorkItemState> {
  return new Map(items.map((i) => [i.id, i]));
}

function add(id: string, overrides: Partial<ProposalNode> = {}): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: { kind: 'task' },
    patch: null,
    ...overrides,
  };
}

function modify(id: string, overrides: Partial<ProposalNode> = {}): ProposalNode {
  return {
    id,
    op: 'modify',
    workItemId: REAL_TARGET,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: null,
    patch: null,
    ...overrides,
  };
}

/** Run the gate with sensible defaults for the parts a case doesn't exercise. */
function validate(
  items: ProposalNode[],
  opts: {
    liveById?: Map<string, LiveWorkItemState>;
    terminalStatusKeys?: Set<string>;
  } = {},
): void {
  validatePlanProposals({
    items,
    liveById: opts.liveById ?? liveMap(live({ id: REAL_PARENT }), live({ id: REAL_TARGET })),
    terminalStatusKeys: opts.terminalStatusKeys ?? new Set(['done', 'cancelled']),
  });
}

describe('validatePlanProposals — the no-op cases', () => {
  it('accepts an empty plan (a declined / all-empty plan writes nothing)', () => {
    expect(() => validate([])).not.toThrow();
  });

  it('accepts a top-level add of a kind that may be a root', () => {
    expect(() => validate([add('p1', { proposedFields: { kind: 'epic' } })])).not.toThrow();
  });

  it('defaults a kindless add to `task` — the same default materialize applies', () => {
    // A task IS a legal root, so a kindless top-level add passes...
    expect(() => validate([add('p1', { proposedFields: null })])).not.toThrow();
    // ...and is rejected under a bug parent, which may only hold subtasks —
    // proving the default really is `task` and not something permissive.
    expect(() =>
      validate([add('p1', { proposedFields: {}, parentRef: REAL_PARENT })], {
        liveById: liveMap(live({ id: REAL_PARENT, kind: 'bug' })),
      }),
    ).toThrow(PlanGrammarError);
  });
});

describe('validatePlanProposals — the kind-parent grammar', () => {
  // The contract, written independently: child → the parents that may hold it.
  const ALLOWED_PARENTS: Record<IssueType, ReadonlySet<IssueType>> = {
    epic: new Set<IssueType>([]),
    story: new Set<IssueType>(['epic']),
    task: new Set<IssueType>(['epic', 'story']),
    bug: new Set<IssueType>(['epic', 'story', 'task']),
    subtask: new Set<IssueType>(['story', 'task', 'bug']),
  };

  for (const parentKind of ISSUE_TYPES) {
    for (const childKind of ISSUE_TYPES) {
      const legal = ALLOWED_PARENTS[childKind].has(parentKind);
      it(`${legal ? 'accepts' : 'rejects'} an add of a ${childKind} under a REAL ${parentKind}`, () => {
        const run = (): void =>
          validate([add('p1', { proposedFields: { kind: childKind }, parentRef: REAL_PARENT })], {
            liveById: liveMap(live({ id: REAL_PARENT, kind: parentKind })),
          });
        if (legal) expect(run).not.toThrow();
        else expect(run).toThrow(PlanGrammarError);
      });

      it(`${legal ? 'accepts' : 'rejects'} an add of a ${childKind} under an INTRA-PLAN ${parentKind}`, () => {
        // Place the PARENT add legally itself (a subtask may not be top-level),
        // so the assertion isolates the CHILD's placement.
        const run = (): void =>
          validate([
            add('parent', {
              proposedFields: { kind: parentKind },
              parentRef: parentKind === 'subtask' ? REAL_PARENT : null,
            }),
            add('child', {
              proposedFields: { kind: childKind },
              parentRef: `${TEMP_REF_PREFIX}parent`,
            }),
          ]);
        if (legal) expect(run).not.toThrow();
        else expect(run).toThrow(PlanGrammarError);
      });
    }
  }

  it('rejects a top-level subtask — a kind that requires a parent', () => {
    expect(() => validate([add('p1', { proposedFields: { kind: 'subtask' } })])).toThrow(
      PlanGrammarError,
    );
  });

  it('reports `illegal_parent` and the offending proposal id', () => {
    try {
      validate([add('p9', { proposedFields: { kind: 'epic' }, parentRef: REAL_PARENT })]);
      expect.unreachable('an epic under a story must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('illegal_parent');
      expect((err as PlanGrammarError).planItemId).toBe('p9');
      expect((err as PlanGrammarError).code).toBe('PLAN_GRAMMAR_VIOLATION');
    }
  });

  it('rejects an add proposing a kind that is not an issue type', () => {
    try {
      validate([add('p1', { proposedFields: { kind: 'milestone' } })]);
      expect.unreachable('an unknown kind must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('unknown_kind');
    }
  });

  it('rejects an add whose intra-plan PARENT proposes an unknown kind', () => {
    expect(() =>
      validate([
        add('parent', { proposedFields: { kind: 'milestone' } }),
        add('child', { proposedFields: { kind: 'task' }, parentRef: `${TEMP_REF_PREFIX}parent` }),
      ]),
    ).toThrow(PlanGrammarError);
  });

  it('rejects a real parent row whose kind is not an issue type (the unreachable guard)', () => {
    try {
      validate([add('p1', { proposedFields: { kind: 'task' }, parentRef: REAL_PARENT })], {
        liveById: liveMap(live({ id: REAL_PARENT, kind: 'milestone' })),
      });
      expect.unreachable('an unknown parent kind must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGrammarError);
      expect((err as PlanGrammarError).reason).toBe('unknown_kind');
    }
  });

  it('does not gate a modify on the grammar — a patch cannot re-parent or re-kind', () => {
    expect(() => validate([modify('m1', { patch: { blockedByAdd: [] } })])).not.toThrow();
  });
});

describe('validatePlanProposals — the intra-plan ref graph', () => {
  it('rejects a parentRef naming no add in the plan', () => {
    try {
      validate([add('p1', { parentRef: `${TEMP_REF_PREFIX}ghost` })]);
      expect.unreachable('a dangling temp parentRef must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('dangling');
      expect((err as PlanRefGraphError).code).toBe('INVALID_PLAN_REF_GRAPH');
    }
  });

  it('rejects a parentRef naming a work item outside this workspace', () => {
    expect(() =>
      validate([add('p1', { parentRef: 'wi_elsewhere' })], { liveById: liveMap() }),
    ).toThrow(PlanRefGraphError);
  });

  it('rejects a dangling blockedByRef (temp and real alike)', () => {
    expect(() => validate([add('p1', { blockedByRefs: [`${TEMP_REF_PREFIX}ghost`] })])).toThrow(
      PlanRefGraphError,
    );
    expect(() =>
      validate([add('p1', { blockedByRefs: ['wi_ghost'] })], { liveById: liveMap() }),
    ).toThrow(PlanRefGraphError);
  });

  it('rejects a dangling ref inside a modify patch, either side', () => {
    expect(() =>
      validate([modify('m1', { patch: { blockedByAdd: [`${TEMP_REF_PREFIX}ghost`] } })]),
    ).toThrow(PlanRefGraphError);
    expect(() => validate([modify('m1', { patch: { blockedByRemove: ['wi_ghost'] } })])).toThrow(
      PlanRefGraphError,
    );
  });

  it('accepts modify patch refs that resolve (a null patch is a no-op)', () => {
    expect(() =>
      validate([
        add('a1'),
        modify('m1', {
          patch: { blockedByAdd: [`${TEMP_REF_PREFIX}a1`], blockedByRemove: [REAL_PARENT] },
        }),
        modify('m2', { patch: null }),
      ]),
    ).not.toThrow();
  });

  it('rejects the same blocker listed twice (the is_blocked_by edge is unique)', () => {
    try {
      validate([add('p1', { blockedByRefs: [REAL_TARGET, REAL_TARGET] })]);
      expect.unreachable('a duplicate blockedByRef must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('duplicate');
    }
  });

  it('rejects a proposal that references ITSELF', () => {
    try {
      validate([add('p1', { blockedByRefs: [`${TEMP_REF_PREFIX}p1`] })]);
      expect.unreachable('a self-reference must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
    }
  });

  it('rejects a parentRef CYCLE (no parent-before-child order exists)', () => {
    try {
      validate([
        add('a', { parentRef: `${TEMP_REF_PREFIX}b`, proposedFields: { kind: 'story' } }),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a`, proposedFields: { kind: 'story' } }),
      ]);
      expect.unreachable('a parentRef cycle must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cycle');
    }
  });

  it('rejects a LONGER parentRef cycle (a → b → c → a)', () => {
    expect(() =>
      validate([
        add('a', { parentRef: `${TEMP_REF_PREFIX}c`, proposedFields: { kind: 'story' } }),
        add('b', { parentRef: `${TEMP_REF_PREFIX}a`, proposedFields: { kind: 'story' } }),
        add('c', { parentRef: `${TEMP_REF_PREFIX}b`, proposedFields: { kind: 'story' } }),
      ]),
    ).toThrow(PlanRefGraphError);
  });

  it('accepts a deep intra-plan chain regardless of the proposals order', () => {
    // Child listed FIRST — order in the plan imposes nothing; only the ref graph does.
    expect(() =>
      validate([
        add('leaf', {
          parentRef: `${TEMP_REF_PREFIX}mid`,
          proposedFields: { kind: 'subtask' },
        }),
        add('mid', { parentRef: `${TEMP_REF_PREFIX}root`, proposedFields: { kind: 'story' } }),
        add('root', { proposedFields: { kind: 'epic' } }),
      ]),
    ).not.toThrow();
  });

  it('accepts a diamond — two children under one parent is not a cycle', () => {
    expect(() =>
      validate([
        add('root', { proposedFields: { kind: 'story' } }),
        add('c1', { parentRef: `${TEMP_REF_PREFIX}root`, proposedFields: { kind: 'task' } }),
        add('c2', {
          parentRef: `${TEMP_REF_PREFIX}root`,
          proposedFields: { kind: 'task' },
          blockedByRefs: [`${TEMP_REF_PREFIX}c1`],
        }),
      ]),
    ).not.toThrow();
  });
});

describe('validatePlanProposals — done-work immutability', () => {
  it('rejects a modify targeting a terminal work item', () => {
    try {
      validate([modify('m1')], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      });
      expect.unreachable('a modify of done work must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanTargetImmutableError);
      expect((err as PlanTargetImmutableError).planItemId).toBe('m1');
      expect((err as PlanTargetImmutableError).workItemId).toBe(REAL_TARGET);
      expect((err as PlanTargetImmutableError).status).toBe('done');
      expect((err as PlanTargetImmutableError).code).toBe('PLAN_TARGET_IMMUTABLE');
    }
  });

  it('rejects a remove targeting a terminal work item', () => {
    expect(() =>
      validate([modify('r1', { op: 'remove' })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'done' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('is keyed on the `done` CATEGORY, not the `done` key — `cancelled` is terminal too', () => {
    expect(() =>
      validate([modify('m1')], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'cancelled' })),
      }),
    ).toThrow(PlanTargetImmutableError);
  });

  it('accepts a modify/remove of a non-terminal target', () => {
    expect(() =>
      validate([modify('m1'), modify('r1', { op: 'remove' })], {
        liveById: liveMap(live({ id: REAL_TARGET, status: 'in_review' })),
      }),
    ).not.toThrow();
  });

  it('leaves a target that resolves to nothing to materialize (which rolls back)', () => {
    // Note the ref check does NOT cover `workItemId` — a target archived out from
    // under the plan is the 7.21.3 staleness concern, surfaced by materialize as
    // `PlanItemTargetMissingError` inside the (rolled-back) transaction.
    expect(() => validate([modify('m1', { workItemId: null })])).not.toThrow();
  });

  it('does not gate an `add` on immutability (it targets nothing)', () => {
    expect(() =>
      validate([add('p1')], { terminalStatusKeys: new Set(['done', 'cancelled', 'todo']) }),
    ).not.toThrow();
  });
});

describe('collectReferencedWorkItemIds', () => {
  it('collects every REAL id a plan references, deduplicated, and no temp refs', () => {
    const ids = collectReferencedWorkItemIds([
      add('a1', { parentRef: 'wi_1', blockedByRefs: ['wi_2', `${TEMP_REF_PREFIX}a2`] }),
      add('a2', { parentRef: `${TEMP_REF_PREFIX}a1` }),
      modify('m1', {
        workItemId: 'wi_3',
        patch: { blockedByAdd: ['wi_1'], blockedByRemove: ['wi_4'] },
      }),
      modify('r1', { op: 'remove', workItemId: 'wi_5', patch: { blockedByAdd: ['wi_6'] } }),
    ]);
    // `wi_1` appears twice in the input and once here; `r1` is a remove, so its
    // patch is never read by the gate — but collecting its refs is harmless.
    expect([...ids].sort()).toEqual(['wi_1', 'wi_2', 'wi_3', 'wi_4', 'wi_5', 'wi_6']);
  });

  it('returns nothing for a plan of top-level adds', () => {
    expect(collectReferencedWorkItemIds([add('a1'), add('a2')])).toEqual([]);
  });
});
