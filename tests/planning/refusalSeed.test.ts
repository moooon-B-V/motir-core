import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import {
  REFUSAL_SEED_COMPOSERS,
  REFUSAL_SEED_NAMESPACE,
  isRefusalSeedGate,
  refusalSeedComposerFor,
  type SeedComposerInput,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
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
