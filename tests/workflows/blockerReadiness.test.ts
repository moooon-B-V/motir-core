import { describe, expect, it } from 'vitest';
import {
  classifyBlockerReadiness,
  isOpenBlocker,
  type BlockerReadinessState,
} from '@/lib/workItems/blockerReadiness';

// Unit tests for the blocker-readiness classifier (MOTIR-3050 lifted it out of
// `workItemsService` so `plansService.materialize` can reach the SAME rule when
// it chooses a materialized add's birth status). The DB-backed behaviour is
// covered by tests/ready/* and tests/integration/plans/plansService.test.ts;
// these pin the pure predicate directly — including the fail-safe arm no
// integration path can reach, because every caller loads the terminal set for
// every blocker project before asking.

const terminal = new Map<string, Set<string>>([['p1', new Set(['done', 'cancelled'])]]);

function blocker(over: Partial<BlockerReadinessState> = {}): BlockerReadinessState {
  return { status: 'todo', projectId: 'p1', sessionBranch: null, ...over };
}

describe('classifyBlockerReadiness', () => {
  it('no blockers → ready, no lineage', () => {
    expect(classifyBlockerReadiness([], terminal)).toEqual({
      ready: true,
      sessionBranches: [],
      inheritedSessionBranch: null,
      conflicting: false,
    });
  });

  it('a TERMINAL blocker is satisfied and contributes no lineage', () => {
    const cls = classifyBlockerReadiness(
      [blocker({ status: 'done', sessionBranch: 'session/ignored' })],
      terminal,
    );
    expect(cls.ready).toBe(true);
    expect(cls.sessionBranches).toEqual([]);
  });

  it('an INTEGRATED blocker is satisfied and contributes its lineage', () => {
    const cls = classifyBlockerReadiness([blocker({ sessionBranch: 'session/a' })], terminal);
    expect(cls.ready).toBe(true);
    expect(cls.inheritedSessionBranch).toBe('session/a');
  });

  it('two integrated lineages CONFLICT → not ready', () => {
    const cls = classifyBlockerReadiness(
      [blocker({ sessionBranch: 'session/b' }), blocker({ sessionBranch: 'session/a' })],
      terminal,
    );
    expect(cls.ready).toBe(false);
    expect(cls.conflicting).toBe(true);
    expect(cls.sessionBranches).toEqual(['session/a', 'session/b']); // sorted
  });

  it('an OPEN blocker holds the item back', () => {
    expect(classifyBlockerReadiness([blocker()], terminal).ready).toBe(false);
  });

  it('a blocker whose PROJECT is absent from the terminal map counts as OPEN (fail-safe)', () => {
    // The map is built from the blockers themselves, so this cannot happen on
    // any shipped path — the arm exists so an incomplete map can never make an
    // unfinished blocker read as done. Asserted rather than assumed.
    const cls = classifyBlockerReadiness([blocker({ status: 'done', projectId: 'p2' })], terminal);
    expect(cls.ready).toBe(false);
  });
});

describe('isOpenBlocker', () => {
  it('is false for terminal and for integrated, true otherwise', () => {
    expect(isOpenBlocker(blocker({ status: 'done' }), terminal)).toBe(false);
    expect(isOpenBlocker(blocker({ sessionBranch: 'session/a' }), terminal)).toBe(false);
    expect(isOpenBlocker(blocker(), terminal)).toBe(true);
  });

  it('treats an unknown project as open (the same fail-safe arm)', () => {
    expect(isOpenBlocker(blocker({ status: 'done', projectId: 'p2' }), terminal)).toBe(true);
  });
});
