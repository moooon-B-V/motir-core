// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { arrivesInsideAnchor, surfaceArrivalTrail } from '@/lib/planning/surfaceArrival';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { ALLOWED_CHILD_TYPES, ISSUE_TYPES } from '@/lib/issues/parentRules';

// THE ARRIVAL RULE (MOTIR-6160, Story MOTIR-6154) — where the planning surface's
// canvas OPENS. The rule is one pure function precisely so it can be ruled on
// here once, rather than through three entrances' worth of component render.

const EPIC = { id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' };
const STORY = { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story' };

function anchorOf(kind: WorkItemKindDto) {
  return { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind };
}

describe('surfaceArrivalTrail', () => {
  it('a CONTAINER anchor opens INSIDE it — ancestors ++ the anchor', () => {
    const trail = surfaceArrivalTrail({ anchor: anchorOf('story'), ancestors: [EPIC] });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_7']);
    // The LAST crumb is the level the canvas loads, so it is the anchor itself.
    expect(trail.at(-1)).toEqual({
      id: 'wi_7',
      crumbKey: 'MOTIR-7',
      label: 'MOTIR-7 · The anchor',
    });
  });

  it('a `subtask` anchor stays BESIDE — ancestors only, the ring case', () => {
    // The one structural leaf: nothing may be parented to a subtask, so it has no
    // inside to open. This is MOTIR-2070's arrival, kept for exactly this kind.
    const trail = surfaceArrivalTrail({ anchor: anchorOf('subtask'), ancestors: [EPIC, STORY] });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3']);
  });

  it.each<WorkItemKindDto>(['epic', 'story', 'task', 'bug'])(
    'a `%s` anchor opens inside it',
    (kind) => {
      const trail = surfaceArrivalTrail({ anchor: anchorOf(kind), ancestors: [EPIC] });
      expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_7']);
      expect(arrivesInsideAnchor(anchorOf(kind))).toBe(true);
    },
  );

  it('a NULL anchor opens the root — the no-existence-leak degradation', () => {
    // `fetchPlanningAnchor` answers `null` for a stale, deleted, foreign or
    // forbidden key alike, and all four must be indistinguishable from "no target
    // was named". The ancestors are dropped rather than kept: a trail with no
    // anchor is not a level anyone asked for.
    expect(surfaceArrivalTrail({ anchor: null, ancestors: [EPIC, STORY] })).toEqual([]);
    expect(arrivesInsideAnchor(null)).toBe(false);
  });

  it('a ROOT-LEVEL container anchor opens on its own children, with a one-crumb trail', () => {
    // An epic has no ancestors, so the whole trail is the epic itself — the canvas
    // opens on its stories rather than on the project root.
    const trail = surfaceArrivalTrail({ anchor: anchorOf('epic'), ancestors: [] });

    expect(trail.map((c) => c.id)).toEqual(['wi_7']);
  });

  it('a DEEP ancestor chain is carried root-first, in order', () => {
    const deep = [
      EPIC,
      STORY,
      { id: 'wi_5', identifier: 'MOTIR-5', title: 'A task' },
      { id: 'wi_6', identifier: 'MOTIR-6', title: 'A bug' },
    ];
    const trail = surfaceArrivalTrail({ anchor: anchorOf('bug'), ancestors: deep });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3', 'wi_5', 'wi_6', 'wi_7']);
    expect(trail.map((c) => c.crumbKey)).toEqual([
      'MOTIR-1',
      'MOTIR-3',
      'MOTIR-5',
      'MOTIR-6',
      'MOTIR-7',
    ]);
  });

  it('every crumb carries the shared `identifier · title` label and its crumbKey', () => {
    // Not a second label format: `workItemCrumbLabel` is the one the roadmap, the
    // plan review and the plain canvas all render, so an arrival crumb and a
    // hand-drilled crumb are indistinguishable.
    const trail = surfaceArrivalTrail({ anchor: anchorOf('story'), ancestors: [EPIC] });

    expect(trail[0]).toEqual({
      id: 'wi_1',
      crumbKey: 'MOTIR-1',
      label: 'MOTIR-1 · Refine AI planning',
    });
  });

  it('is pure — it does not mutate the ancestors it was handed', () => {
    const ancestors = [EPIC];
    surfaceArrivalTrail({ anchor: anchorOf('story'), ancestors });

    expect(ancestors).toHaveLength(1);
  });
});

describe('the rule is TOTAL over the kind enum, and agrees with the kind matrix', () => {
  // ⚠️ THE POINT OF THIS BLOCK. `KIND_HAS_INSIDE` is a `Record<WorkItemKindDto,
  // boolean>` with no default arm, so a NEW kind fails the TYPE check rather than
  // falling through to whichever branch was written last. A type-level guarantee
  // is invisible at runtime, so this is what makes it legible — and what catches
  // the other half the compiler cannot see: that the map still AGREES with
  // `lib/issues/parentRules.ts`, which is the source of truth for which kinds
  // take children. A kind added there and defaulted here would type-check.
  // Taken from the kind matrix ITSELF rather than re-typed, so a kind added
  // there arrives in this loop automatically and is ruled on by the next case.
  const ALL_KINDS = ISSUE_TYPES as readonly WorkItemKindDto[];

  it('answers every kind the enum has, with no throw and no undefined', () => {
    for (const kind of ALL_KINDS) {
      expect(typeof arrivesInsideAnchor(anchorOf(kind))).toBe('boolean');
    }
  });

  it('"has an inside" is exactly "the kind matrix gives it children"', () => {
    for (const kind of ALL_KINDS) {
      expect(arrivesInsideAnchor(anchorOf(kind))).toBe(ALLOWED_CHILD_TYPES[kind].length > 0);
    }
  });

  it('`subtask` is the ONLY leaf — so it is the only kind that arrives beside', () => {
    const beside = ALL_KINDS.filter((k) => !arrivesInsideAnchor(anchorOf(k)));
    expect(beside).toEqual(['subtask']);
  });
});
