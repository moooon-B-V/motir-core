import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  ApprovalGateKind,
  ApprovalGateRefusalVerdict,
  ApprovalGateState,
} from '@/generated/prisma/client';
import {
  REFUSAL_SEED_COMPOSERS,
  REFUSAL_SEED_NAMESPACE,
  isRefusalSeedGate,
  refusalSeedAnchorsOnParent,
  refusalSeedComposerFor,
  type SeedComposerInput,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-6207 — the refusal-seed predicate is TOTAL over `ApprovalGateKind`: it
// is iterated over the generated enum (not a hand-written list), so a new kind
// or state is answered here the day it lands.

// The decision kinds seed whatever the verdict column holds (it is only ever set on a
// design refusal); a design refusal seeds ONLY with the Re-plan verdict (MOTIR-6424).
const SEEDS = new Set([
  'decision_approval:changes_requested:*',
  'decision_choice:changes_requested:*',
  'decision_confirmation:overturned:*',
  'design_result:changes_requested:re_plan',
]);

describe('isRefusalSeedGate', () => {
  const kinds = Object.values(ApprovalGateKind);
  const states = Object.values(ApprovalGateState);
  const verdicts = [null, ...Object.values(ApprovalGateRefusalVerdict)];

  it('iterates a non-empty enum, and every seed it names is a real kind:state pair', () => {
    const pairs = new Set(kinds.flatMap((k) => states.map((s) => `${k}:${s}`)));
    expect(kinds.length).toBeGreaterThan(0);
    for (const seed of SEEDS) expect(pairs.has(seed.split(':').slice(0, 2).join(':'))).toBe(true);
    expect(verdicts).toEqual([null, 'revise', 're_plan']);
  });

  for (const kind of kinds) {
    for (const state of states) {
      for (const refusalVerdict of verdicts) {
        const expected =
          SEEDS.has(`${kind}:${state}:*`) || SEEDS.has(`${kind}:${state}:${refusalVerdict}`);
        it(`${kind} in ${state} (verdict ${refusalVerdict}) → ${expected}`, () => {
          expect(isRefusalSeedGate({ kind, state, refusalVerdict })).toBe(expected);
        });
      }
    }
  }

  it('a design refusal: only Re-plan seeds — Revise, a GitHub-synced (verdict-less) refusal, approved and awaiting do not', () => {
    const design = (state: ApprovalGateState, refusalVerdict: ApprovalGateRefusalVerdict | null) =>
      isRefusalSeedGate({ kind: 'design_result', state, refusalVerdict });
    expect(design('changes_requested', 're_plan')).toBe(true);
    expect(design('changes_requested', 'revise')).toBe(false);
    expect(design('changes_requested', null)).toBe(false);
    expect(design('approved', null)).toBe(false);
    expect(design('awaiting', null)).toBe(false);
  });

  it('answers false for a kind outside the enum rather than throwing', () => {
    expect(
      isRefusalSeedGate({
        kind: 'not_a_kind' as ApprovalGateKind,
        state: 'changes_requested',
        refusalVerdict: 're_plan',
      }),
    ).toBe(false);
  });
});

describe('refusalSeedAnchorsOnParent', () => {
  it('only a design Re-plan anchors on the card’s parent', () => {
    for (const kind of Object.values(ApprovalGateKind)) {
      expect(refusalSeedAnchorsOnParent(kind)).toBe(kind === 'design_result');
    }
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
  waitingKeys: string[] = [],
  anchorKey = 'PROD-7',
): SeedComposerInput {
  return {
    card: { key: 'PROD-7', title: 'Pick the queue' },
    gate: { kind, state, noteMd },
    supersedesKeys,
    anchorKey,
    waitingKeys,
  };
}

describe('REFUSAL_SEED_COMPOSERS', () => {
  it('holds exactly the three decision refusals and the design Re-plan', () => {
    expect(Object.keys(REFUSAL_SEED_COMPOSERS).sort()).toEqual([
      'decision_approval',
      'decision_choice',
      'decision_confirmation',
      'design_result',
    ]);
  });

  it('refusalSeedComposerFor answers null for a kind with no entry (and for a prototype name)', () => {
    expect(refusalSeedComposerFor('acceptance_result')).toBeNull();
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

// MOTIR-6424 — the DESIGN Re-plan composer: the MOTIR-6420 design's first-turn
// contract, in both locales.
describe('the design Re-plan composer', () => {
  const design = (waitingKeys: string[], noteMd: string | null = REASON) =>
    input('design_result', 'changes_requested', ['PROD-99'], noteMd, waitingKeys, 'PROD-3');

  it('names the design, quotes the reason, lists the waiting keys in order and asks on the PARENT (en)', () => {
    expect(REFUSAL_SEED_COMPOSERS.design_result!(design(['PROD-8', 'PROD-9']), t('en'))).toBe(
      [
        'PROD-7 · Pick the queue',
        'Changes were requested on this design.',
        `The reason given:\n“${REASON}”`,
        'The work items waiting on this design: PROD-8, PROD-9',
        'Re-plan PROD-3 from that reason: this design and the work waiting on it.',
      ].join('\n\n'),
    );
  });

  it('with nothing waiting, the waiting line is OMITTED — no empty or “none” line (and no supersedes keys)', () => {
    const turn = REFUSAL_SEED_COMPOSERS.design_result!(design([]), t('en'));
    expect(turn).toBe(
      [
        'PROD-7 · Pick the queue',
        'Changes were requested on this design.',
        `The reason given:\n“${REASON}”`,
        'Re-plan PROD-3 from that reason: this design and the work waiting on it.',
      ].join('\n\n'),
    );
    expect(turn).not.toContain('PROD-99');
  });

  it('renders in zh from the zh catalogue', () => {
    expect(REFUSAL_SEED_COMPOSERS.design_result!(design(['PROD-8', 'PROD-9']), t('zh'))).toBe(
      [
        'PROD-7 · Pick the queue',
        '这个设计被要求修改。',
        `给出的理由：\n“${REASON}”`,
        '等待这个设计的工作项：PROD-8、PROD-9',
        '请根据这个理由重新规划 PROD-3：这个设计以及等待它的工作。',
      ].join('\n\n'),
    );
  });

  it('a refusal with no reason omits the reason line', () => {
    expect(REFUSAL_SEED_COMPOSERS.design_result!(design([], null), t('en'))).toBe(
      'PROD-7 · Pick the queue\n\nChanges were requested on this design.\n\nRe-plan PROD-3 from that reason: this design and the work waiting on it.',
    );
  });
});
