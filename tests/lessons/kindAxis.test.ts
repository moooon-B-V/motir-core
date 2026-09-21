import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { LESSON_KINDS, NON_CARD_LAY_TARGETS } from '@/lib/lessons/kindAxis';

// The LESSON store's kind axis (MOTIR-5622) — the module both lesson tools read
// instead of each keeping a private literal.
//
// The members are pinned LITERALLY on purpose: this list mirrors motir-ai's
// `LessonWorkItemKind` enum, which lives in another repository, so the only
// check this side can make is against the members that enum carries — in its
// order, since that is the order motir-ai's own routing-axes test pins.

describe('the kind axis', () => {
  it('is every lay target — project, onboarding, then the five work-item kinds', () => {
    expect(LESSON_KINDS).toEqual([
      'project',
      'onboarding',
      'epic',
      'story',
      'task',
      'bug',
      'subtask',
    ]);
  });

  it('is DERIVED from the non-card lay targets and the work-item kinds, not re-listed', () => {
    expect(LESSON_KINDS).toEqual([...NON_CARD_LAY_TARGETS, ...ISSUE_TYPES]);
  });

  it('neither non-card lay target is a work-item kind', () => {
    for (const target of NON_CARD_LAY_TARGETS) {
      expect(ISSUE_TYPES as readonly string[]).not.toContain(target);
    }
  });
});
