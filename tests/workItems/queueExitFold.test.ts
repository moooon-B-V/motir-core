import { describe, expect, it } from 'vitest';
import {
  deliverySetIsGreen,
  deliveryStateForCard,
  deliveryStateForPromotion,
  foldCardCiState,
  queueExitHoldsAtHead,
  type QueueExitFacts,
} from '@/lib/workItems/deliverySet';
import type { PrCiState } from '@/lib/github/prCiState';

// MOTIR-5717 — a merge-queue FAILURE at the pull request's current head folds into
// the CARD's `ciState` as `failing`, through ONE predicate the promotion hold also
// calls. These are the pure halves; the recomputes on the exit, on Queue again and
// on a push are asserted against a real Postgres in `tests/github/mergeQueueExit.test.ts`
// and `tests/github/queueAgain.test.ts`.

const HEAD = 'sha-head';
const at = (overrides: Partial<QueueExitFacts> = {}): QueueExitFacts => ({
  disposition: 'failure',
  requeuedAt: null,
  headSha: HEAD,
  ...overrides,
});

describe('queueExitHoldsAtHead (MOTIR-5717)', () => {
  it('holds for a failure, not re-queued, at the current head', () => {
    expect(queueExitHoldsAtHead(at(), HEAD)).toBe(true);
  });

  it('does not hold for a neutral exit — a manual removal says nothing about the work', () => {
    expect(queueExitHoldsAtHead(at({ disposition: 'neutral' }), HEAD)).toBe(false);
  });

  it('does not hold once Queue again has stamped it', () => {
    expect(queueExitHoldsAtHead(at({ requeuedAt: new Date() }), HEAD)).toBe(false);
  });

  it('does not hold once a push has moved the head', () => {
    expect(queueExitHoldsAtHead(at({ headSha: 'sha-old' }), HEAD)).toBe(false);
  });

  it('holds nothing for a member with no exit, or with no head at all', () => {
    expect(queueExitHoldsAtHead(undefined, HEAD)).toBe(false);
    expect(queueExitHoldsAtHead(null, HEAD)).toBe(false);
    // No check rows ⇒ no head ⇒ the exit cannot name it.
    expect(queueExitHoldsAtHead(at(), undefined)).toBe(false);
    expect(queueExitHoldsAtHead(at(), null)).toBe(false);
  });
});

describe('deliveryStateForCard with a standing queue failure (MOTIR-5717)', () => {
  it('reads failing whatever the member’s own verdict says', () => {
    for (const state of ['passing', 'running', 'failing', null] as const) {
      for (const cannotReport of [true, false]) {
        expect(deliveryStateForCard(state, cannotReport, true)).toBe('failing');
      }
    }
  });

  it('leaves the member’s own verdict alone when nothing holds it', () => {
    expect(deliveryStateForCard('passing', false, false)).toBe('passing');
    expect(deliveryStateForCard(null, true, false)).toBe('passing');
    expect(deliveryStateForCard(null, false, false)).toBe('running');
  });
});

describe('the card verdict and the promotion agree, WITH queue exits (MOTIR-5717)', () => {
  // The badge promises that `passing` needs no badge BECAUSE green CI has already
  // moved the card to In Review. With a standing queue failure the promotion refuses
  // (`isPromotable` = every member green AND no member held), so the fold must not
  // say `passing` either. This is the table the card's criterion names: own states
  // {failing, running, passing, null-can-report, null-cannot-report} × exits {none,
  // failure@head, failure@old-head, failure-requeued, neutral@head}.
  const OWN: { label: string; state: PrCiState; cannotReport: boolean }[] = [
    { label: 'failing', state: 'failing', cannotReport: false },
    { label: 'running', state: 'running', cannotReport: false },
    { label: 'passing', state: 'passing', cannotReport: false },
    { label: 'null-can-report', state: null, cannotReport: false },
    { label: 'null-cannot-report', state: null, cannotReport: true },
  ];
  const EXITS: { label: string; exit: QueueExitFacts | undefined }[] = [
    { label: 'none', exit: undefined },
    { label: 'failure@head', exit: at() },
    { label: 'failure@old-head', exit: at({ headSha: 'sha-old' }) },
    { label: 'failure-requeued', exit: at({ requeuedAt: new Date() }) },
    { label: 'neutral@head', exit: at({ disposition: 'neutral' }) },
  ];

  /** A member with a verdict has check rows, so a head; a `null` member has none. */
  const headOf = (state: PrCiState) => (state === null ? undefined : HEAD);

  const verdicts = (
    members: { state: PrCiState; cannotReport: boolean; exit?: QueueExitFacts }[],
  ) => {
    const held = members.map((m) => queueExitHoldsAtHead(m.exit, headOf(m.state)));
    const card = foldCardCiState(
      members.map((m, i) => deliveryStateForCard(m.state, m.cannotReport, held[i]!)),
    );
    const promotable =
      deliverySetIsGreen(members.map((m) => deliveryStateForPromotion(m.state, m.cannotReport))) &&
      !held.some(Boolean);
    return { card, promotable };
  };

  const single = OWN.flatMap((own) => EXITS.map((e) => [own.label, e.label, own, e.exit] as const));

  it.each(single)('one member %s × exit %s: fold === passing ⇔ promotable', (_o, _e, own, exit) => {
    const { card, promotable } = verdicts([{ ...own, exit }]);
    expect(card === 'passing').toBe(promotable);
  });

  it.each(single)(
    'beside a green sibling, member %s × exit %s: fold === passing ⇔ promotable',
    (_o, _e, own, exit) => {
      const { card, promotable } = verdicts([
        { state: 'passing', cannotReport: false },
        { ...own, exit },
      ]);
      expect(card === 'passing').toBe(promotable);
    },
  );

  it('an ejected green pull request reads failing, and the promotion refuses it', () => {
    const { card, promotable } = verdicts([{ state: 'passing', cannotReport: false, exit: at() }]);
    expect(card).toBe('failing');
    expect(promotable).toBe(false);
  });
});
