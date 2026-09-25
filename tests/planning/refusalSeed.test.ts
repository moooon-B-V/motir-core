import { describe, expect, it } from 'vitest';
import { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import { isRefusalSeedGate } from '@/lib/planning/refusalSeed';

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
