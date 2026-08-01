import { describe, expect, it } from 'vitest';
import {
  CANCELLED_STATUS_KEY,
  MOTIR_SEED_BURST_END,
  addToProvenanceBucket,
  classifyImplementationSource,
  classifyPlanningSource,
  classifyProvenance,
  emptyProvenanceBucket,
  PROVENANCE_BACKFILL_SAMPLE_SIZE,
  type ClassifyProvenanceOptions,
  type ProvenanceBackfillRow,
} from '@/lib/workItems/provenanceBackfill';

// The provenance-backfill DECISION TABLE (MOTIR-1758) — the rules, exercised as
// a pure function over a row shape, with no database. These are the assertions
// that keep the backfill HONEST: what it stamps, and (just as load-bearing)
// every branch on which it deliberately stamps nothing. The DB-backed
// idempotence + immutability guards live in
// tests/integration/work-items/provenance-backfill.test.ts.

const SEED_END = MOTIR_SEED_BURST_END;
const IN_BURST = new Date(SEED_END.getTime() - 1_000);
const AFTER_BURST = new Date(SEED_END.getTime() + 1_000);

const OPTS: ClassifyProvenanceOptions = {
  seedBurstEnd: SEED_END,
  implementedStatusKeys: new Set(['done']),
};

function row(overrides: Partial<ProvenanceBackfillRow> = {}): ProvenanceBackfillRow {
  return {
    id: 'wi_1',
    identifier: 'MOTIR-1',
    createdAt: IN_BURST,
    status: 'todo',
    type: 'code',
    executor: 'coding_agent',
    planningSource: null,
    implementationSource: null,
    hasLinkedPr: false,
    sessionBranch: null,
    ...overrides,
  };
}

describe('classifyPlanningSource', () => {
  it('stamps `manual` on a row created inside the seed burst', () => {
    expect(classifyPlanningSource(row({ createdAt: IN_BURST }), OPTS)).toBe('manual');
  });

  it('treats a row created EXACTLY at the boundary as seed (inclusive)', () => {
    expect(classifyPlanningSource(row({ createdAt: new Date(SEED_END) }), OPTS)).toBe('manual');
  });

  it('stamps `mcp` on a row created after the burst', () => {
    expect(classifyPlanningSource(row({ createdAt: AFTER_BURST }), OPTS)).toBe('mcp');
  });

  it('leaves an already-stamped row alone, on BOTH sides of the boundary', () => {
    expect(
      classifyPlanningSource(row({ createdAt: IN_BURST, planningSource: 'native' }), OPTS),
    ).toBeNull();
    expect(
      classifyPlanningSource(row({ createdAt: AFTER_BURST, planningSource: 'manual' }), OPTS),
    ).toBeNull();
  });

  it('honours a caller-supplied boundary rather than the MOTIR constant', () => {
    const later = { ...OPTS, seedBurstEnd: new Date(AFTER_BURST.getTime() + 1_000) };
    // The same row that is `mcp` under the MOTIR boundary is `manual` under a later one.
    expect(classifyPlanningSource(row({ createdAt: AFTER_BURST }), OPTS)).toBe('mcp');
    expect(classifyPlanningSource(row({ createdAt: AFTER_BURST }), later)).toBe('manual');
  });
});

describe('classifyImplementationSource', () => {
  it('stamps `byok` on a done item with a linked PR', () => {
    expect(classifyImplementationSource(row({ status: 'done', hasLinkedPr: true }), OPTS)).toBe(
      'byok',
    );
  });

  it('stamps `byok` on a done item carrying a session branch', () => {
    expect(
      classifyImplementationSource(row({ status: 'done', sessionBranch: 'subtask/MOTIR-1' }), OPTS),
    ).toBe('byok');
  });

  it('stamps `manual` on a done human-executed card with no PR and no branch', () => {
    expect(
      classifyImplementationSource(row({ status: 'done', executor: 'human', type: 'code' }), OPTS),
    ).toBe('manual');
  });

  it('stamps `manual` on a done `type: manual` card even when its executor is unset', () => {
    expect(
      classifyImplementationSource(row({ status: 'done', executor: null, type: 'manual' }), OPTS),
    ).toBe('manual');
  });

  it('leaves a done CODING-AGENT card with no evidence NULL — never `manual`', () => {
    // The load-bearing abstention: those are cards that shipped before the
    // GitHub App was installed, not cards someone did by hand. Same line
    // `applyStatusTransition`'s manual lane already draws.
    expect(
      classifyImplementationSource(
        row({ status: 'done', executor: 'coding_agent', type: 'code' }),
        OPTS,
      ),
    ).toBeNull();
  });

  it('leaves every not-yet-implemented status NULL, PR or not', () => {
    for (const status of ['todo', 'blocked', 'in_progress', 'in_review']) {
      expect(classifyImplementationSource(row({ status }), OPTS)).toBeNull();
      expect(classifyImplementationSource(row({ status, hasLinkedPr: true }), OPTS)).toBeNull();
      expect(classifyImplementationSource(row({ status, executor: 'human' }), OPTS)).toBeNull();
    }
  });

  it('leaves a CANCELLED item NULL — abandoned is not implemented', () => {
    // `cancelled` is a done-CATEGORY status, so only its exclusion from
    // `implementedStatusKeys` keeps it out. Assert the exclusion holds even
    // with PR evidence present.
    expect(
      classifyImplementationSource(
        row({ status: CANCELLED_STATUS_KEY, hasLinkedPr: true, executor: 'human' }),
        OPTS,
      ),
    ).toBeNull();
  });

  it('leaves an already-stamped row alone, even when the rules would say otherwise', () => {
    expect(
      classifyImplementationSource(
        row({ status: 'done', hasLinkedPr: true, implementationSource: 'manual' }),
        OPTS,
      ),
    ).toBeNull();
    expect(
      classifyImplementationSource(
        row({ status: 'done', executor: 'human', implementationSource: 'hosted' }),
        OPTS,
      ),
    ).toBeNull();
  });

  it('honours a project-specific implemented-status set, not a hardcoded `done`', () => {
    const custom = { ...OPTS, implementedStatusKeys: new Set(['shipped']) };
    expect(
      classifyImplementationSource(row({ status: 'shipped', hasLinkedPr: true }), custom),
    ).toBe('byok');
    expect(
      classifyImplementationSource(row({ status: 'done', hasLinkedPr: true }), custom),
    ).toBeNull();
  });

  it('NEVER returns `hosted`, across the whole decision table', () => {
    const statuses = ['todo', 'blocked', 'in_progress', 'in_review', 'done', CANCELLED_STATUS_KEY];
    const executors = ['coding_agent', 'human', null] as const;
    const types = ['code', 'manual', null] as const;
    for (const status of statuses) {
      for (const executor of executors) {
        for (const type of types) {
          for (const hasLinkedPr of [true, false]) {
            for (const sessionBranch of ['b', null]) {
              const verdict = classifyImplementationSource(
                row({ status, executor, type, hasLinkedPr, sessionBranch }),
                OPTS,
              );
              expect(verdict).not.toBe('hosted');
            }
          }
        }
      }
    }
  });
});

describe('classifyProvenance (both halves together)', () => {
  it('a seed-burst human card that is done gets manual planning + manual implementation', () => {
    expect(
      classifyProvenance(row({ createdAt: IN_BURST, status: 'done', executor: 'human' }), OPTS),
    ).toEqual({ planningSource: 'manual', implementationSource: 'manual' });
  });

  it('a post-seed done card with a PR gets mcp planning + byok implementation', () => {
    expect(
      classifyProvenance(row({ createdAt: AFTER_BURST, status: 'done', hasLinkedPr: true }), OPTS),
    ).toEqual({ planningSource: 'mcp', implementationSource: 'byok' });
  });

  it('an open post-seed card gets planning only — implementation stays NULL', () => {
    expect(
      classifyProvenance(row({ createdAt: AFTER_BURST, status: 'in_progress' }), OPTS),
    ).toEqual({ planningSource: 'mcp', implementationSource: null });
  });

  it('a fully-stamped row yields nothing to write on either half', () => {
    expect(
      classifyProvenance(
        row({
          status: 'done',
          hasLinkedPr: true,
          planningSource: 'native',
          implementationSource: 'byok',
        }),
        OPTS,
      ),
    ).toEqual({ planningSource: null, implementationSource: null });
  });
});

describe('the report buckets', () => {
  it('counts every row but keeps a bounded identifier sample', () => {
    const bucket = emptyProvenanceBucket();
    for (let i = 1; i <= PROVENANCE_BACKFILL_SAMPLE_SIZE + 3; i += 1) {
      addToProvenanceBucket(bucket, `MOTIR-${i}`);
    }
    expect(bucket.count).toBe(PROVENANCE_BACKFILL_SAMPLE_SIZE + 3);
    expect(bucket.sample).toHaveLength(PROVENANCE_BACKFILL_SAMPLE_SIZE);
    expect(bucket.sample[0]).toBe('MOTIR-1');
    expect(bucket.written).toBe(0);
  });
});

describe('the MOTIR seed-burst boundary constant', () => {
  it('is the instant read off the live tenant between MOTIR-756 and MOTIR-757', () => {
    // Pinned so an accidental edit to the derived boundary is a test failure,
    // not a silent re-attribution of ~1 700 rows. The derivation (and the query
    // that produced it) is documented on the constant.
    expect(MOTIR_SEED_BURST_END.toISOString()).toBe('2026-06-15T14:27:16.297Z');
  });
});
