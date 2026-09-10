import { describe, expect, it } from 'vitest';
import {
  deliverySetShortfall,
  hasDeliverySetShortfall,
  type DeliveryMember,
} from '@/lib/workItems/deliverySet';

// MOTIR-5004 — the delivery-set predicate's THREE outcomes.
//
// `deliverySetShortfall` decided on the boolean `merged` alone, which collapses
// two opposite situations into one branch: a pull request that has NOT MERGED
// YET, and one that was CLOSED and never will. The first is the entire reason
// the gate exists; the second delivers nothing and must not hold anything.
//
// The live incident: MOTIR-4789 was delivered by `motir-core#2715`, closed
// unmerged, and then by `#2747`, merged onto `main`. The merge did not complete
// the card, and the note it posted called the closed pull request "still open".
// Nothing re-decides such a card — the gate runs only on a change-request event,
// and a closed pull request emits no further merge — so the hold was permanent.
//
// The domain has three values and the member now carries them, so the branch
// each one takes is asserted here rather than inferred from a boolean.

function member(over: Partial<DeliveryMember> = {}): DeliveryMember {
  return {
    repoLabel: 'moooon/motir-core',
    number: 1,
    state: 'open',
    baseRef: 'main',
    defaultBranch: 'main',
    ...over,
  };
}

describe('the three outcomes, one per pull-request state', () => {
  it('HOLDS on an OPEN delivery — the case the gate exists for', () => {
    const shortfall = deliverySetShortfall([member({ number: 2715, state: 'open' })]);

    expect(shortfall.outstanding).toEqual(['moooon/motir-core#2715']);
    expect(hasDeliverySetShortfall(shortfall)).toBe(true);
  });

  it('PASSES a delivery merged onto its own default branch', () => {
    const shortfall = deliverySetShortfall([member({ number: 2747, state: 'merged' })]);

    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
    expect(hasDeliverySetShortfall(shortfall)).toBe(false);
  });

  it('IGNORES a CLOSED, unmerged delivery — it delivers nothing and never will', () => {
    const shortfall = deliverySetShortfall([member({ number: 2715, state: 'closed' })]);

    // In NO list — not outstanding, not stranded, not unknown. An abandoned
    // pull request is not work the card is waiting for.
    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
    expect(hasDeliverySetShortfall(shortfall)).toBe(false);
  });
});

describe('the incident — MOTIR-4789, one repository, two deliveries', () => {
  it('does NOT hold when the abandoned sibling is the only thing unmerged', () => {
    const shortfall = deliverySetShortfall([
      member({ number: 2715, state: 'closed' }),
      member({ number: 2747, state: 'merged' }),
    ]);

    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
    expect(hasDeliverySetShortfall(shortfall)).toBe(false);
  });

  it('still holds when a genuinely OPEN sibling stands beside the abandoned one', () => {
    // The abandoned member drops out; the open one is what the card waits for.
    // This is the pair that proves the fix narrows the hold rather than removing it.
    const shortfall = deliverySetShortfall([
      member({ number: 2715, state: 'closed' }),
      member({ number: 2747, state: 'merged' }),
      member({ number: 2760, state: 'open' }),
    ]);

    expect(shortfall.outstanding).toEqual(['moooon/motir-core#2760']);
    expect(hasDeliverySetShortfall(shortfall)).toBe(true);
  });
});

describe('an abandoned delivery is excluded BEFORE either base check', () => {
  // Order matters, and getting it wrong reintroduces the defect through a
  // different list. A closed pull request keeps whatever base it targeted, and
  // a row mirrored before base capture has none at all — so an abandoned member
  // tested for its base lands in `strandedBase` or `unknownBase` and holds the
  // card exactly as `outstanding` used to.
  it('does not fall into strandedBase when it targeted a side branch', () => {
    const shortfall = deliverySetShortfall([
      member({ number: 2715, state: 'closed', baseRef: 'some/side-branch' }),
    ]);

    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
  });

  it('does not fall into unknownBase when its base was never recorded', () => {
    const shortfall = deliverySetShortfall([
      member({ number: 2715, state: 'closed', baseRef: null }),
    ]);

    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
  });
});

describe('the MERGED base checks are untouched', () => {
  it('a merge onto a base that is not the trunk is STRANDED', () => {
    const shortfall = deliverySetShortfall([
      member({ number: 2747, state: 'merged', baseRef: 'parent/MOTIR-1' }),
    ]);

    expect(shortfall.strandedBase).toEqual(['moooon/motir-core#2747']);
    expect(hasDeliverySetShortfall(shortfall)).toBe(true);
  });

  it('a merge with no recorded base is UNKNOWN', () => {
    const shortfall = deliverySetShortfall([
      member({ number: 2747, state: 'merged', baseRef: null }),
    ]);

    expect(shortfall.unknownBase).toEqual(['moooon/motir-core#2747']);
    expect(hasDeliverySetShortfall(shortfall)).toBe(true);
  });

  it('compares against THAT repository’s own trunk, never a hard-coded main', () => {
    const shortfall = deliverySetShortfall([
      member({
        repoLabel: 'moooon/motir-ai',
        number: 9,
        state: 'merged',
        baseRef: 'trunk',
        defaultBranch: 'trunk',
      }),
    ]);

    expect(hasDeliverySetShortfall(shortfall)).toBe(false);
  });
});

describe('the empty set still ABSTAINS — nearly every card in the tree', () => {
  it('returns no shortfall at all', () => {
    const shortfall = deliverySetShortfall([]);

    expect(shortfall).toEqual({ outstanding: [], strandedBase: [], unknownBase: [] });
    expect(hasDeliverySetShortfall(shortfall)).toBe(false);
  });
});
