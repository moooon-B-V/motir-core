import { describe, expect, it } from 'vitest';
import { DERIVED_EVENT_KINDS, mergeTimeline, revisionCount } from '@/lib/plans/timeline';
import type { PlanHistoryEventDto } from '@/lib/dto/planReview';

// The timeline MERGE, as pure logic (Story MOTIR-3532 · Subtask MOTIR-3536).
//
// `tests/integration/plans/planTimelineMerge.test.ts` proves the SEAM — that the
// service reads real rows and the rules fire on them. This file pins the rules
// themselves, including the two a database fixture cannot reliably produce: a
// same-millisecond tie between a lifecycle event and the revision written in the
// very same transaction, and a stored kind this code has never heard of.
//
// The expectations are written INDEPENDENTLY of the implementation — they restate
// `design/ai-planning/design-notes.md` Part X §5 rather than mirror the code.

function derived(kind: string, at: string): PlanHistoryEventDto {
  return { id: `lifecycle:${kind}`, kind, at };
}

function content(
  id: string,
  kind: string,
  at: string,
  over: Partial<PlanHistoryEventDto> = {},
): PlanHistoryEventDto {
  return { id, kind, at, count: 1, ...over };
}

describe('ordering', () => {
  it('interleaves by time, not by which list an event came from', () => {
    const out = mergeTimeline(
      [
        derived('created', '2026-08-26T08:00:00.000Z'),
        derived('planned', '2026-08-26T08:10:00.000Z'),
      ],
      [content('r1', 'appended', '2026-08-26T08:05:00.000Z')],
    );
    expect(out.map((e) => e.kind)).toEqual(['created', 'appended', 'planned']);
  });

  it('puts a DERIVED event first when the two share a millisecond', () => {
    // The tie is real rather than theoretical: `createPlan` writes the plan row
    // and its revision in ONE transaction, and `changed_at` has millisecond
    // precision. *Generation started* must stay above the append it enclosed.
    const at = '2026-08-26T08:00:00.000Z';
    const out = mergeTimeline([derived('created', at)], [content('r1', 'appended', at)]);
    expect(out.map((e) => e.kind)).toEqual(['created', 'appended']);
  });

  it('keeps two events of the SAME list in their given order at an identical instant', () => {
    // The last tie-break, and the one that keeps a run collapsible: two stored
    // events written in the same millisecond must stay in trail order, or an
    // adjacent run can be split by a sort that reverses two of its members.
    const at = '2026-08-26T08:00:00.000Z';
    const out = mergeTimeline(
      [],
      [content('r1', 'appended', at, { count: 2 }), content('r2', 'edited', at, { count: 1 })],
    );
    expect(out.map((e) => e.id)).toEqual(['r1', 'r2']);
  });

  it('keeps a not-yet-reached event (a null timestamp) last', () => {
    const out = mergeTimeline(
      [derived('created', '2026-08-26T08:00:00.000Z'), { id: 'x', kind: 'approved', at: null }],
      [content('r1', 'appended', '2026-08-26T09:00:00.000Z')],
    );
    expect(out.map((e) => e.kind)).toEqual(['created', 'appended', 'approved']);
  });

  it('is a pure function of its inputs — it mutates neither list', () => {
    const d = [derived('created', '2026-08-26T08:00:00.000Z')];
    const c = [
      content('r1', 'appended', '2026-08-26T08:01:00.000Z'),
      content('r2', 'appended', '2026-08-26T08:02:00.000Z'),
    ];
    mergeTimeline(d, c);
    expect(c[0]!.count).toBe(1);
    expect(c[0]!.until).toBeUndefined();
  });
});

describe('collapse — kind + actor + adjacency', () => {
  it('folds an adjacent run of one kind by one actor, summing the count and spanning the time', () => {
    const out = mergeTimeline(
      [],
      [
        content('r1', 'edited', '2026-08-26T08:24:00.000Z', {
          actorHarness: 'Claude Code',
          actorSource: 'mcp',
        }),
        content('r2', 'edited', '2026-08-26T08:25:00.000Z', {
          actorHarness: 'Claude Code',
          actorSource: 'mcp',
        }),
        content('r3', 'edited', '2026-08-26T08:26:00.000Z', {
          actorHarness: 'Claude Code',
          actorSource: 'mcp',
        }),
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.at).toBe('2026-08-26T08:24:00.000Z');
    expect(out[0]!.until).toBe('2026-08-26T08:26:00.000Z');
    // The run keeps the FIRST member's id, so the row has a stable identity.
    expect(out[0]!.id).toBe('r1');
  });

  it('sums the members’ own counts, so an 11-proposal append is not counted as one', () => {
    const out = mergeTimeline(
      [],
      [
        content('r1', 'appended', '2026-08-26T08:00:00.000Z', { count: 11 }),
        content('r2', 'appended', '2026-08-26T08:00:01.000Z', { count: 4 }),
      ],
    );
    expect(out[0]!.count).toBe(15);
  });

  it('does NOT fold two different kinds', () => {
    const out = mergeTimeline(
      [],
      [
        content('r1', 'appended', '2026-08-26T08:00:00.000Z'),
        content('r2', 'edited', '2026-08-26T08:00:01.000Z'),
      ],
    );
    expect(out.map((e) => e.kind)).toEqual(['appended', 'edited']);
  });

  it('does NOT fold across a different ACTOR, however close in time', () => {
    const out = mergeTimeline(
      [],
      [
        content('r1', 'edited', '2026-08-26T08:00:00.000Z', { byName: 'Zhu Yue' }),
        content('r2', 'edited', '2026-08-26T08:00:00.001Z', {
          actorSource: 'mcp',
          actorHarness: 'Claude Code',
        }),
      ],
    );
    expect(out).toHaveLength(2);
    // A time WINDOW would have merged these; adjacency plus actor identity
    // cannot, which is exactly why the key is what it is.
  });

  it('does NOT let a run swallow a lifecycle event that falls between its members', () => {
    const out = mergeTimeline(
      [derived('planned', '2026-08-26T08:01:00.000Z')],
      [
        content('r1', 'appended', '2026-08-26T08:00:00.000Z'),
        content('r2', 'appended', '2026-08-26T08:02:00.000Z'),
      ],
    );
    expect(out.map((e) => e.kind)).toEqual(['appended', 'planned', 'appended']);
    expect(out[0]!.count).toBe(1);
    expect(out[2]!.count).toBe(1);
  });

  it('never folds a LIFECYCLE event into anything — it carries no count', () => {
    const out = mergeTimeline(
      [
        derived('created', '2026-08-26T08:00:00.000Z'),
        derived('planned', '2026-08-26T08:00:01.000Z'),
      ],
      [],
    );
    expect(out).toHaveLength(2);
    for (const ev of out) expect(ev.count).toBeUndefined();
  });
});

describe('revisionCount — a content event covers at least one act', () => {
  it('reads the payload’s own count', () => {
    expect(revisionCount({ proposalCount: 7 })).toBe(7);
  });

  it('falls back to ONE for a payload that carries none, or a nonsense one', () => {
    expect(revisionCount(null)).toBe(1);
    expect(revisionCount({})).toBe(1);
    expect(revisionCount({ proposalCount: 0 })).toBe(1);
    expect(revisionCount({ proposalCount: -3 })).toBe(1);
    expect(revisionCount({ proposalCount: 'many' })).toBe(1);
    expect(revisionCount({ proposalCount: Number.NaN })).toBe(1);
  });
});

describe('the derived-kind set is an EXCLUSION, so a new verb renders rather than vanishing', () => {
  it('names exactly the four the lifecycle columns already say', () => {
    expect([...DERIVED_EVENT_KINDS].sort()).toEqual(['approved', 'created', 'declined', 'planned']);
  });

  it('merges a stored kind this code has never heard of', () => {
    // The sibling story's `removed` — and whatever comes after it. An allow-list
    // would drop it silently from the one surface built to show it.
    expect(DERIVED_EVENT_KINDS.has('removed')).toBe(false);
    const out = mergeTimeline(
      [],
      [content('r1', 'removed', '2026-08-26T08:00:00.000Z', { count: 2 })],
    );
    expect(out.map((e) => e.kind)).toEqual(['removed']);
    expect(out[0]!.count).toBe(2);
  });
});
