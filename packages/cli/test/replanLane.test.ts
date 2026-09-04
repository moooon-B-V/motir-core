import { describe, expect, it } from 'vitest';
import {
  inLane,
  renderElsewhereAnchored,
  renderLaneDecline,
  type Lane,
  type LaneProposal,
} from '../src/replanLane.js';

// THE LANE an unattended loop may approve a re-plan inside (MOTIR-4085).
//
// Everything here is a pure function over a plain object, which is the whole
// reason the check lives in its own module: the arm that matters most is the one
// that DECLINES, and a decline changes nothing observable in an end-to-end run —
// the tree is identical, the card is identical, and only a message says what
// happened. Asserted here on the verdict, and end to end in `replanSignal` on
// what the loop then does with it.

const LANE: Lane = { leafKey: 'PROD-7', parentKey: 'PROD-1', siblingKeys: ['PROD-7', 'PROD-8'] };

function proposal(over: Partial<LaneProposal> = {}): LaneProposal {
  return { op: 'add', workItemKey: null, parentKey: null, parentRef: null, ...over };
}

describe('inLane — what an unattended run may approve on its own', () => {
  it('accepts a MODIFY of the card that refused itself — the ordinary correction', () => {
    const verdict = inLane(
      { proposals: [proposal({ op: 'modify', workItemKey: 'PROD-7' })] },
      LANE,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts a SPLIT — one leaf becomes two siblings under the same parent', () => {
    // ⚠️ THE CASE THE FLAG EXISTS FOR. A subtask parents nothing, so "this card
    // is really two" can only ever mean adding a SIBLING; if this were out of
    // lane the flag would approve nothing worth approving.
    const verdict = inLane(
      {
        proposals: [
          proposal({ op: 'modify', workItemKey: 'PROD-7' }),
          proposal({ op: 'add', parentKey: 'PROD-1', parentRef: 'cm_parent' }),
        ],
      },
      LANE,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts REMOVING a sibling that should not exist', () => {
    const verdict = inLane(
      { proposals: [proposal({ op: 'remove', workItemKey: 'PROD-8' })] },
      LANE,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('is case-insensitive about keys, on both sides of the comparison', () => {
    const verdict = inLane(
      { proposals: [proposal({ op: 'modify', workItemKey: 'prod-8' })] },
      { ...LANE, siblingKeys: ['PROD-8'] },
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts an EMPTY plan — there is nothing outside the lane', () => {
    // Degenerate, and worth pinning: a check that answered "not ok" on nothing
    // would decline the one plan that cannot possibly do damage.
    expect(inLane({ proposals: [] }, LANE)).toEqual({ ok: true });
  });

  it('REFUSES a modify of a card outside the sibling level, and NAMES it', () => {
    // ⚠️ THE NAMED LIST IS THE ASSERTION, not the boolean. "Not auto-approved"
    // is something an operator has to go and investigate; "it also modifies
    // PROD-42" is something they can act on at breakfast.
    const verdict = inLane(
      {
        proposals: [
          proposal({ op: 'modify', workItemKey: 'PROD-7' }),
          proposal({ op: 'modify', workItemKey: 'PROD-42' }),
        ],
      },
      LANE,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane).toHaveLength(1);
    expect(verdict.outOfLane[0]).toMatchObject({ op: 'modify', affects: 'PROD-42' });
    expect(verdict.outOfLane[0]?.reason).toContain('neither PROD-7 nor one of its siblings');
  });

  it('REFUSES a modify of the PARENT itself — a container re-plan is a person’s', () => {
    const verdict = inLane(
      { proposals: [proposal({ op: 'modify', workItemKey: 'PROD-1' })] },
      LANE,
    );
    expect(verdict.ok).toBe(false);
  });

  it('REFUSES an add under a DIFFERENT container, and says which', () => {
    const verdict = inLane(
      { proposals: [proposal({ op: 'add', parentKey: 'PROD-2', parentRef: 'cm_other' })] },
      LANE,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane[0]).toMatchObject({
      op: 'add',
      affects: 'a new card under PROD-2',
    });
    expect(verdict.outOfLane[0]?.reason).toContain('outside PROD-1');
  });

  it('REFUSES an add that names NO parent — a new top-level card is not a sibling', () => {
    const verdict = inLane({ proposals: [proposal({ op: 'add' })] }, LANE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane[0]?.affects).toBe('a new card with no parent');
  });

  it('REFUSES an add parented at another PROPOSAL — the plan is building a subtree', () => {
    // A `planItem:` ref means the plan is growing a tree of its own, which is
    // wider than a sibling level by construction. It resolves to no key, and the
    // message says so rather than reporting an unresolvable parent.
    const verdict = inLane(
      { proposals: [proposal({ op: 'add', parentRef: 'planItem:pi_1' })] },
      LANE,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane[0]?.affects).toContain('another card this same plan proposes');
  });

  it('REFUSES a target that did not RESOLVE — an unseeable item is not an absent one', () => {
    // ⚠️ FAILING OPEN HERE WOULD MAKE THE CHECK SILENT EXACTLY WHERE IT IS LEAST
    // ABLE TO SEE. A `modify` whose key came back null names something outside
    // this caller's view, which is precisely the proposal a person should read.
    const verdict = inLane({ proposals: [proposal({ op: 'modify', workItemKey: null })] }, LANE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane[0]?.affects).toBe('an item this run cannot resolve');
  });

  it('names EVERY proposal that fell out, not just the first', () => {
    const verdict = inLane(
      {
        proposals: [
          proposal({ op: 'modify', workItemKey: 'PROD-42' }),
          proposal({ op: 'remove', workItemKey: 'PROD-43' }),
          proposal({ op: 'add', parentKey: 'PROD-2', parentRef: 'cm_other' }),
        ],
      },
      LANE,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.outOfLane.map((p) => p.affects)).toEqual([
      'PROD-42',
      'PROD-43',
      'a new card under PROD-2',
    ]);
  });

  describe('a PARENTLESS leaf', () => {
    const orphan: Lane = { leafKey: 'PROD-7', parentKey: null, siblingKeys: [] };

    it('still accepts a modify of itself', () => {
      expect(
        inLane({ proposals: [proposal({ op: 'modify', workItemKey: 'PROD-7' })] }, orphan),
      ).toEqual({ ok: true });
    });

    it('refuses every add, because it has no sibling level to add to', () => {
      // Not an accident of the comparison: a card with no parent has nowhere a
      // sibling could go, so the honest answer is that the correction is wider
      // than this card — and the reason says exactly that.
      const verdict = inLane({ proposals: [proposal({ op: 'add', parentKey: 'PROD-1' })] }, orphan);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.outOfLane[0]?.reason).toContain('no parent');
    });
  });
});

describe('the messages a decline prints', () => {
  it('opens by saying it is NOT a failure, and names what fell out', () => {
    // ⚠️ THE FIRST LINE IS LOAD-BEARING. An operator who reads a decline as an
    // error learns to distrust the bound the whole flag rests on.
    const text = renderLaneDecline('PROD-7', {
      outOfLane: [{ op: 'modify', affects: 'PROD-42', reason: 'it is a different story' }],
    });
    expect(text).toContain('NOT auto-approved');
    expect(text).toContain('This is not a failure');
    expect(text).toContain('modify PROD-42 — it is a different story');
    expect(text).toContain('Review the plan in Motir');
  });

  it('reports an ELSEWHERE-anchored plan as the election it is, with the server’s sentence', () => {
    const text = renderElsewhereAnchored('PROD-7', 'No submitted plan is anchored to PROD-7.');
    expect(text).toContain('elected the lane that goes to a person');
    expect(text).toContain('No submitted plan is anchored to PROD-7.');
    expect(text).not.toContain('failure');
  });
});
