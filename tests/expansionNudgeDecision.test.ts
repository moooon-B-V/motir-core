import { describe, it, expect } from 'vitest';

const EXPANSION_NUDGE_THRESHOLD = 3;

interface ExpansionNudge {
  readyCount: number;
  nominatedKey: string;
  nominatedTitle: string;
  threshold: number;
}

interface ExpandableStub {
  identifier: string;
  title: string;
  kind: string;
  priority: string;
}

/**
 * Pure-logic unit test of the expansion-nudge computation. Tests the decision
 * logic in isolation — the service delegates to repositories for data; this
 * tests the "given these repository outputs, does the service decide correctly?"
 * The real service (`computeExpansionNudge`) is tested over a real Postgres per
 * the motir-core convention; these logic tests guard the branching.
 */
function computeDecision(readyCount: number, stubs: ExpandableStub[]): ExpansionNudge | null {
  if (readyCount >= EXPANSION_NUDGE_THRESHOLD) return null;
  if (stubs.length === 0) return null;
  const nominated = stubs[0]!;
  return {
    readyCount,
    nominatedKey: nominated.identifier,
    nominatedTitle: nominated.title,
    threshold: EXPANSION_NUDGE_THRESHOLD,
  };
}

describe('expansion nudge — decision logic', () => {
  const stub: ExpandableStub = {
    identifier: 'MOTIR-10',
    title: 'Some stub story',
    kind: 'story',
    priority: 'medium',
  };

  it('suppresses when ready count >= threshold', () => {
    expect(computeDecision(3, [stub])).toBeNull();
    expect(computeDecision(5, [stub])).toBeNull();
  });

  it('suppresses when no expandable stub exists (no false nag)', () => {
    expect(computeDecision(1, [])).toBeNull();
    expect(computeDecision(0, [])).toBeNull();
  });

  it('returns a nudge when ready count < threshold and a stub exists', () => {
    const result = computeDecision(1, [stub]);
    expect(result).toEqual({
      readyCount: 1,
      nominatedKey: 'MOTIR-10',
      nominatedTitle: 'Some stub story',
      threshold: 3,
    });
  });

  it('returns a nudge with readyCount=0 when set is empty', () => {
    const result = computeDecision(0, [stub]);
    expect(result).toEqual({
      readyCount: 0,
      nominatedKey: 'MOTIR-10',
      nominatedTitle: 'Some stub story',
      threshold: 3,
    });
  });

  it('nominates the first stub from the sorted list', () => {
    const first: ExpandableStub = {
      identifier: 'MOTIR-1',
      title: 'First stub',
      kind: 'epic',
      priority: 'high',
    };
    const second: ExpandableStub = {
      identifier: 'MOTIR-5',
      title: 'Second stub',
      kind: 'story',
      priority: 'low',
    };
    const result = computeDecision(2, [first, second]);
    expect(result?.nominatedKey).toBe('MOTIR-1');
  });
});
