import { describe, expect, it } from 'vitest';

import {
  MAX_ITEMS_PER_SPRINT,
  MAX_PROPOSED_SPRINTS,
  parseSprintAssignmentDelta,
  SprintAssignmentValidationError,
} from '@/lib/ai/sprintAssignment';

// Subtask 7.13.5 · MOTIR-918 — the SHAPE half of the approve re-validation.
//
// The delta arrives on a request body carrying the packing a human APPROVED and
// possibly EDITED, so it is untrusted input regardless of what produced its
// ancestor. These lock that it is re-derived from `unknown` rather than cast:
// every malformed form is a typed error thrown BEFORE the semantic pass (which
// reads the database) ever runs, and the counts the persist reports back are
// DERIVED, never inherited from the body.

/** The one well-formed sprint every case starts from. */
function sprint(): Record<string, unknown> {
  return {
    tempId: 'sprint:1',
    name: 'Sprint 1',
    lengthDays: 2,
    itemKeys: ['PROD-1', 'PROD-2'],
    totalEstimateMinutes: 120,
    capacityMinutes: 720,
    oversizedKeys: [],
    rationale: 'two leaves, in dependency order',
  };
}

/** A minimal well-formed v1 delta; `over` patches any field for the bad cases. */
function delta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deltaVersion: 'v1',
    sprintLengthDays: 2,
    capacityMinutes: 720,
    agentMinutesPerDay: 360,
    itemCount: 2,
    totalEstimateMinutes: 120,
    unestimatedKeys: [],
    oversizedKeys: [],
    sprints: [sprint()],
    ...over,
  };
}

describe('parseSprintAssignmentDelta — the well-formed shape (MOTIR-918)', () => {
  it('parses a v1 packing and returns the typed delta', () => {
    const parsed = parseSprintAssignmentDelta(delta());
    expect(parsed.deltaVersion).toBe('v1');
    expect(parsed.sprintLengthDays).toBe(2);
    expect(parsed.sprints).toHaveLength(1);
    expect(parsed.sprints[0]?.itemKeys).toEqual(['PROD-1', 'PROD-2']);
    expect(parsed.sprints[0]?.rationale).toBe('two leaves, in dependency order');
  });

  it('accepts an EMPTY packing — "nothing to schedule" is a legitimate proposal', () => {
    const parsed = parseSprintAssignmentDelta(delta({ sprints: [], itemCount: 0 }));
    expect(parsed.sprints).toEqual([]);
    expect(parsed.itemCount).toBe(0);
  });

  it('upper-cases work-item keys, matching every other key-taking seam', () => {
    const parsed = parseSprintAssignmentDelta(
      delta({
        sprints: [
          {
            tempId: 'sprint:1',
            name: 'S',
            lengthDays: 2,
            itemKeys: ['prod-7'],
            totalEstimateMinutes: 60,
            capacityMinutes: 720,
            oversizedKeys: [],
            rationale: '',
          },
        ],
      }),
    );
    expect(parsed.sprints[0]?.itemKeys).toEqual(['PROD-7']);
  });

  it('DERIVES itemCount + totalEstimateMinutes rather than trusting the body', () => {
    // A human edit that moved an item but left the summary counters stale must
    // not make the persist report a number that disagrees with what it wrote.
    const parsed = parseSprintAssignmentDelta(
      delta({ itemCount: 999, totalEstimateMinutes: 999_999 }),
    );
    expect(parsed.itemCount).toBe(2);
    expect(parsed.totalEstimateMinutes).toBe(120);
  });

  it('tolerates an absent rationale / oversizedKeys — neither is load-bearing for the persist', () => {
    const parsed = parseSprintAssignmentDelta(
      delta({
        sprints: [
          {
            tempId: 'sprint:1',
            name: 'S',
            lengthDays: 2,
            itemKeys: ['PROD-1'],
            totalEstimateMinutes: 60,
            capacityMinutes: 720,
          },
        ],
      }),
    );
    expect(parsed.sprints[0]?.rationale).toBe('');
    expect(parsed.sprints[0]?.oversizedKeys).toEqual([]);
  });
});

describe('parseSprintAssignmentDelta — rejections (MOTIR-918)', () => {
  it('rejects a non-object', () => {
    expect(() => parseSprintAssignmentDelta(null)).toThrow(SprintAssignmentValidationError);
    expect(() => parseSprintAssignmentDelta('v1')).toThrow(SprintAssignmentValidationError);
    expect(() => parseSprintAssignmentDelta([])).toThrow(SprintAssignmentValidationError);
  });

  it('refuses an unknown deltaVersion instead of best-effort parsing it', () => {
    // The whole point of §3.2's independent versioning is that the persist
    // SWITCHES on the version; a v2 packing this build has never seen must not
    // be interpreted with v1 rules.
    expect(() => parseSprintAssignmentDelta(delta({ deltaVersion: 'v2' }))).toThrow(
      /unsupported sprint-assignment deltaVersion/,
    );
    expect(() => parseSprintAssignmentDelta(delta({ deltaVersion: undefined }))).toThrow(
      SprintAssignmentValidationError,
    );
  });

  it('enforces the "sprint:<n>" tempId grammar', () => {
    // The persist keys its tempId → real-id map on this value, so a free-form
    // tempId would silently create a sprint nothing references.
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), tempId: 'abc' }] })),
    ).toThrow(/must match "sprint:<n>"/);
  });

  it('rejects duplicate tempIds', () => {
    expect(() =>
      parseSprintAssignmentDelta(
        delta({ sprints: [sprint(), { ...sprint(), itemKeys: ['PROD-3'] }] }),
      ),
    ).toThrow(/duplicate sprint tempId/);
  });

  it('rejects an item assigned to TWO sprints — an item has exactly one sprint', () => {
    expect(() =>
      parseSprintAssignmentDelta(
        delta({
          sprints: [sprint(), { ...sprint(), tempId: 'sprint:2', itemKeys: ['PROD-2'] }],
        }),
      ),
    ).toThrow(/PROD-2 is assigned to two sprints/);
  });

  it('rejects malformed sprint fields (name, lengthDays, itemKeys)', () => {
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), name: '  ' }] })),
    ).toThrow(/name must be a non-empty string/);
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), lengthDays: 0 }] })),
    ).toThrow(/lengthDays must be a positive integer/);
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), itemKeys: 'PROD-1' }] })),
    ).toThrow(/itemKeys must be an array/);
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), itemKeys: ['PROD-1', ''] }] })),
    ).toThrow(/itemKeys\[1\] must be a non-empty string/);
  });

  it('rejects malformed top-level numbers', () => {
    expect(() => parseSprintAssignmentDelta(delta({ sprintLengthDays: 0 }))).toThrow(
      /sprintLengthDays must be a positive integer/,
    );
    expect(() => parseSprintAssignmentDelta(delta({ capacityMinutes: -1 }))).toThrow(
      /capacityMinutes must be a non-negative integer/,
    );
    expect(() => parseSprintAssignmentDelta(delta({ sprints: {} }))).toThrow(
      /sprints must be an array/,
    );
  });

  it('caps the batch sizes a hand-edited body can ask for', () => {
    const tooManySprints = Array.from({ length: MAX_PROPOSED_SPRINTS + 1 }, (_, i) => ({
      ...sprint(),
      tempId: `sprint:${i + 1}`,
      itemKeys: [`PROD-${i + 1}`],
    }));
    expect(() => parseSprintAssignmentDelta(delta({ sprints: tooManySprints }))).toThrow(
      /sprints holds 101 entries/,
    );

    const tooManyItems = Array.from(
      { length: MAX_ITEMS_PER_SPRINT + 1 },
      (_, i) => `PROD-${i + 1}`,
    );
    expect(() =>
      parseSprintAssignmentDelta(delta({ sprints: [{ ...sprint(), itemKeys: tooManyItems }] })),
    ).toThrow(/itemKeys holds 101 entries/);
  });
});
