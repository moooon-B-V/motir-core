import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import {
  REFUSAL_SEED_COMPOSERS,
  REFUSAL_SEED_NAMESPACE,
  anchorOf,
  isPickSeedGate,
  isPlanningSeedGate,
  isRefusalSeedGate,
  readChosenOption,
  refusalSeedComposerFor,
  seedIntentOf,
  type SeedAncestor,
  type SeedComposerInput,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
import type { ChosenOption } from '@/lib/approvalGates/choiceOptions';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-6207 — the refusal-seed predicate is TOTAL over `ApprovalGateKind`: it
// is iterated over the generated enum (not a hand-written list), so a new kind
// or state is answered here the day it lands.

const SEEDS = new Set([
  'decision_approval:changes_requested',
  'decision_choice:changes_requested',
  'decision_confirmation:overturned',
]);

describe('isRefusalSeedGate', () => {
  const kinds = Object.values(ApprovalGateKind);
  const states = Object.values(ApprovalGateState);

  it('iterates a non-empty enum, and every seed it names is a real kind:state pair', () => {
    const pairs = new Set(kinds.flatMap((k) => states.map((s) => `${k}:${s}`)));
    expect(kinds.length).toBeGreaterThan(0);
    for (const seed of SEEDS) expect(pairs.has(seed)).toBe(true);
  });

  for (const kind of kinds) {
    for (const state of states) {
      const expected = SEEDS.has(`${kind}:${state}`);
      it(`${kind} in ${state} → ${expected}`, () => {
        expect(isRefusalSeedGate({ kind, state })).toBe(expected);
      });
    }
  }

  it('answers false for a kind outside the enum rather than throwing', () => {
    expect(
      isRefusalSeedGate({ kind: 'not_a_kind' as ApprovalGateKind, state: 'changes_requested' }),
    ).toBe(false);
  });
});

// MOTIR-6208 — the per-kind COMPOSER REGISTRY, rendered from fixtures against the
// REAL catalogues in both locales.

const t = (locale: 'en' | 'zh'): SeedTranslator =>
  createTranslator({
    locale,
    messages: locale === 'en' ? en : zh,
    namespace: REFUSAL_SEED_NAMESPACE,
  }) as unknown as SeedTranslator;

const REASON = "Not this direction.\nTry the {other} one — it's cheaper.\n\n  Indented line.";

function input(
  kind: ApprovalGateKind,
  state: ApprovalGateState,
  supersedesKeys: string[] = [],
  noteMd: string | null = REASON,
): SeedComposerInput {
  return {
    card: { key: 'PROD-7', title: 'Pick the queue' },
    gate: { kind, state, noteMd },
    supersedesKeys,
  };
}

describe('REFUSAL_SEED_COMPOSERS', () => {
  it('holds exactly the three refusal kinds', () => {
    expect(Object.keys(REFUSAL_SEED_COMPOSERS).sort()).toEqual([
      'decision_approval',
      'decision_choice',
      'decision_confirmation',
    ]);
  });

  it('refusalSeedComposerFor answers null for a kind with no entry (and for a prototype name)', () => {
    expect(refusalSeedComposerFor('design_result')).toBeNull();
    expect(refusalSeedComposerFor('toString' as ApprovalGateKind)).toBeNull();
    expect(refusalSeedComposerFor('decision_approval')).toBe(
      REFUSAL_SEED_COMPOSERS.decision_approval,
    );
  });

  it('Request changes on a decision (en) — key + title, verb, verbatim reason, the ask', () => {
    const turn = REFUSAL_SEED_COMPOSERS.decision_approval!(
      input('decision_approval', 'changes_requested'),
      t('en'),
    );
    expect(turn).toBe(
      [
        'PROD-7 · Pick the queue',
        'Changes were requested on this decision.',
        `The reason given:\n“${REASON}”`,
        'Re-plan this work item from that reason.',
      ].join('\n\n'),
    );
  });

  it('None of these on a choice (en)', () => {
    const turn = REFUSAL_SEED_COMPOSERS.decision_choice!(
      input('decision_choice', 'changes_requested', ['PROD-1']),
      t('en'),
    );
    expect(turn).toContain('None of the options on this choice was picked.');
    expect(turn).toContain(REASON);
    // A choice never names supersedes keys, even when handed some.
    expect(turn).not.toContain('PROD-1');
  });

  it('an Overturn with SEVERAL supersedes keys names each, in order (en + zh)', () => {
    const i = input('decision_confirmation', 'overturned', ['PROD-2', 'PROD-3', 'PROD-5']);
    const enTurn = REFUSAL_SEED_COMPOSERS.decision_confirmation!(i, t('en'));
    expect(enTurn).toBe(
      [
        'PROD-7 · Pick the queue',
        'This decision was overturned.',
        `The reason given:\n“${REASON}”`,
        'The work items it superseded: PROD-2, PROD-3, PROD-5',
        'Re-plan this work item from that reason.',
      ].join('\n\n'),
    );
    const zhTurn = REFUSAL_SEED_COMPOSERS.decision_confirmation!(i, t('zh'));
    expect(zhTurn).toBe(
      [
        'PROD-7 · Pick the queue',
        '这个决策已被推翻。',
        `给出的理由：\n“${REASON}”`,
        '它曾取代的工作项：PROD-2、PROD-3、PROD-5',
        '请根据这个理由重新规划这个工作项。',
      ].join('\n\n'),
    );
  });

  it('an Overturn with ZERO supersedes keys carries no line for them, and no empty one', () => {
    const turn = REFUSAL_SEED_COMPOSERS.decision_confirmation!(
      input('decision_confirmation', 'overturned', []),
      t('en'),
    );
    expect(turn).not.toContain('superseded');
    expect(turn).not.toMatch(/\n\n\n\n/);
    expect(
      turn.endsWith(
        'This decision was overturned.\n\nThe reason given:\n“' +
          REASON +
          '”\n\nRe-plan this work item from that reason.',
      ),
    ).toBe(true);
  });

  it('every composer renders in zh from the zh catalogue', () => {
    expect(
      REFUSAL_SEED_COMPOSERS.decision_approval!(
        input('decision_approval', 'changes_requested'),
        t('zh'),
      ),
    ).toContain('这个决策被要求修改。');
    expect(
      REFUSAL_SEED_COMPOSERS.decision_choice!(
        input('decision_choice', 'changes_requested'),
        t('zh'),
      ),
    ).toContain('这个选择的选项都没有被选中。');
  });

  it('a refusal recorded without a reason omits the reason line rather than quoting nothing', () => {
    for (const noteMd of [null, '   ']) {
      const turn = REFUSAL_SEED_COMPOSERS.decision_approval!(
        input('decision_approval', 'changes_requested', [], noteMd),
        t('en'),
      );
      expect(turn).toBe(
        'PROD-7 · Pick the queue\n\nChanges were requested on this decision.\n\nRe-plan this work item from that reason.',
      );
    }
  });
});

// ── MOTIR-6433 — the PICK seed: its own predicate, the umbrella, the intent, the
// defensive stamp read, the total anchor resolver, and the pick composer. The
// refusal predicate above is asserted UNCHANGED by the table it already runs.

const STAMP: ChosenOption = {
  optionId: 'managed-object-storage',
  label: 'Managed {object} storage',
  bestFor: "less to operate — it's managed",
  followUp: 'Report exports — the storage adapter,\nthe retention rule and the download page.',
  situation: 'better_than_your_decision',
};

describe('isPickSeedGate / isPlanningSeedGate / seedIntentOf', () => {
  const kinds = Object.values(ApprovalGateKind);
  const states = Object.values(ApprovalGateState);

  for (const kind of kinds) {
    for (const state of states) {
      const pick = kind === 'decision_choice' && state === 'approved';
      it(`${kind} in ${state} with a stamp → pick ${pick}`, () => {
        const gate = { kind, state, chosenOption: STAMP as never };
        expect(isPickSeedGate(gate)).toBe(pick);
        expect(isPlanningSeedGate(gate)).toBe(pick || isRefusalSeedGate(gate));
        if (isPlanningSeedGate(gate)) expect(seedIntentOf(gate)).toBe(pick ? 'plan' : 'replan');
      });
    }
  }

  it('a chosen gate WITHOUT a stamp (decided before the stamp existed) is not a pick seed', () => {
    const gate = {
      kind: 'decision_choice' as const,
      state: 'approved' as const,
      chosenOption: null,
    };
    expect(isPickSeedGate(gate)).toBe(false);
    expect(isPlanningSeedGate(gate)).toBe(false);
  });

  it('isRefusalSeedGate stays false for a pick — the ask and the Re-plan door never widen', () => {
    expect(isRefusalSeedGate({ kind: 'decision_choice', state: 'approved' })).toBe(false);
  });
});

describe('readChosenOption — the stamped JSON, read defensively', () => {
  it('returns a well-formed stamp as is', () => {
    expect(readChosenOption(STAMP)).toBe(STAMP);
  });
  it.each([
    ['null', null],
    ['a string', 'Managed object storage'],
    ['an array', [STAMP]],
    ['a missing followUp', { ...STAMP, followUp: undefined }],
    ['a non-string label', { ...STAMP, label: 7 }],
    ['a missing optionId', { ...STAMP, optionId: undefined }],
    ['a missing bestFor', { ...STAMP, bestFor: undefined }],
  ])('treats %s as no stamp', (_label, value) => {
    expect(readChosenOption(value)).toBeNull();
  });
});

describe('anchorOf — a TOTAL per-kind resolver', () => {
  const PICK = {
    kind: 'decision_choice' as const,
    state: 'approved' as const,
    chosenOption: STAMP as never,
  };
  const a = (key: string, statusCategory: string | null, archived = false): SeedAncestor => ({
    key,
    statusCategory,
    archived,
  });

  it('a pick anchors on the PARENT when it is not done', () => {
    expect(anchorOf(PICK, 'ACME-42', [a('ACME-1', 'in_progress'), a('ACME-40', 'todo')])).toBe(
      'ACME-40',
    );
  });
  it('a pick walks up past a DONE parent to the grandparent — by CATEGORY, not the literal key', () => {
    // The resolver reads the status CATEGORY (the service maps each project status key
    // to it), so a custom done-category status like `shipped` counts as done too.
    expect(anchorOf(PICK, 'ACME-42', [a('ACME-1', 'in_progress'), a('ACME-40', 'done')])).toBe(
      'ACME-1',
    );
  });
  it('a pick walks up past an ARCHIVED parent', () => {
    expect(anchorOf(PICK, 'ACME-42', [a('ACME-1', 'todo'), a('ACME-40', 'todo', true)])).toBe(
      'ACME-1',
    );
  });
  it('a ROOT or FOLDER-FILED choice (no ancestors) anchors at the project', () => {
    expect(anchorOf(PICK, 'ACME-42', [])).toBeNull();
  });
  it('an all-done chain anchors at the project', () => {
    expect(anchorOf(PICK, 'ACME-42', [a('ACME-1', 'done'), a('ACME-40', 'done')])).toBeNull();
  });
  it('an ancestor whose status has no known category counts as open', () => {
    expect(anchorOf(PICK, 'ACME-42', [a('ACME-40', null)])).toBe('ACME-40');
  });

  const kinds = Object.values(ApprovalGateKind);
  for (const kind of kinds) {
    it(`${kind} as a refusal (or any non-pick) anchors on its OWN card`, () => {
      const gate = { kind, state: 'changes_requested' as const, chosenOption: null };
      expect(anchorOf(gate, 'ACME-42', [a('ACME-40', 'todo')])).toBe('ACME-42');
    });
  }

  it('answers its own card for a kind outside the enum rather than throwing', () => {
    const gate = {
      kind: 'not_a_kind' as ApprovalGateKind,
      state: 'approved' as const,
      chosenOption: null,
    };
    expect(anchorOf(gate, 'ACME-42', [a('ACME-40', 'todo')])).toBe('ACME-42');
  });
});

describe('the decision_choice composer — TWO cases, dispatched on state', () => {
  const pickInput = (anchorKey: string | null): SeedComposerInput => ({
    card: { key: 'ACME-42', title: 'Choose where exports live' },
    gate: { kind: 'decision_choice', state: 'approved', noteMd: null },
    supersedesKeys: [],
    chosenOption: STAMP,
    anchorKey,
  });

  it('a PICK on a parent anchor (en) — heading, option + best-if, what it gates (verbatim), the plan ask', () => {
    expect(REFUSAL_SEED_COMPOSERS.decision_choice!(pickInput('ACME-40'), t('en'))).toBe(
      [
        'ACME-42 · Choose where exports live',
        `The option chosen: ${STAMP.label}\nBest if you want: ${STAMP.bestFor}`,
        `What this choice gates:\n${STAMP.followUp}`,
        'Plan this work with the option chosen.',
      ].join('\n\n'),
    );
  });

  it('a PICK at the PROJECT anchor says so right after the heading (en + zh)', () => {
    const en = REFUSAL_SEED_COMPOSERS.decision_choice!(pickInput(null), t('en'));
    expect(en.split('\n\n')[1]).toBe(
      'This choice has no open container, so Motir AI opened on the project.',
    );
    const zh = REFUSAL_SEED_COMPOSERS.decision_choice!(pickInput(null), t('zh'));
    expect(zh).toBe(
      [
        'ACME-42 · Choose where exports live',
        '这个选择没有未完成的上级工作项，所以 Motir AI 在项目上打开。',
        `选中的选项：${STAMP.label}\n如果你更看重：${STAMP.bestFor}`,
        `这个选择决定的工作：\n${STAMP.followUp}`,
        '请按选中的选项规划这项工作。',
      ].join('\n\n'),
    );
  });

  it('a PICK turn never says re-plan', () => {
    const turn = REFUSAL_SEED_COMPOSERS.decision_choice!(pickInput('ACME-40'), t('en'));
    expect(turn).not.toMatch(/re-plan/i);
  });

  it('None of these (changes_requested) still composes the refusal turn byte-for-byte', () => {
    const none = REFUSAL_SEED_COMPOSERS.decision_choice!(
      {
        ...pickInput('ACME-40'),
        gate: { kind: 'decision_choice', state: 'changes_requested', noteMd: REASON },
      },
      t('en'),
    );
    expect(none).toBe(
      [
        'ACME-42 · Choose where exports live',
        'None of the options on this choice was picked.',
        `The reason given:\n“${REASON}”`,
        'Re-plan this work item from that reason.',
      ].join('\n\n'),
    );
  });
});
