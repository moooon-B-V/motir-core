// The LESSON store's KIND axis — one vocabulary for both lesson tools (MOTIR-5622).
//
// ⚠️ WHY THIS MODULE EXISTS. The axis was declared twice, as a private
// `LESSON_KINDS` literal in `add_lesson` and again in `search_lessons`, each
// spelling the five card kinds — the same shape `phaseAxis.ts` removed for the
// phase axis. MOTIR-5622 WIDENS it, and a widening through two private literals
// is how one tool ends up accepting a value the other refuses.
//
// WHAT IT HOLDS. A search narrows by the CELL a pass is in, and a `lay` cell is
// keyed on the TARGET it lays under — so the axis is every LAY TARGET, not only
// the card kinds. Two targets are not cards: `project`, a project's own top
// level, and `onboarding`, a first plan carved from the direction docs. Laying a
// level narrows on the target you lay under, never on the kind of its children.
//
// ⚠️ THIS IS A MIRROR, NOT THE AUTHORITY. The column is motir-ai's
// `LessonWorkItemKind` enum, which motir-ai derives the same way
// (`NON_CARD_LAY_TARGETS` + `PLAN_ITEM_KINDS`, pinned to the enum by its
// `tests/lessonRoutingAxes.test.ts`). `tests/lessons/kindAxis.test.ts` pins this
// list to the same members in the same order.

import { ISSUE_TYPES } from '@/lib/issues/parentRules';

/**
 * The lay targets that are not work-item kinds, broadest first. `onboarding` is a
 * lay target on this axis ONLY — it is not the planner's phase bucket
 * (`onboarding_planning`, the `mistakeType` argument), which is a different axis.
 */
export const NON_CARD_LAY_TARGETS = ['project', 'onboarding'] as const;

/** The axis: the two non-card lay targets, then the five work-item kinds. */
export const LESSON_KINDS = [...NON_CARD_LAY_TARGETS, ...ISSUE_TYPES] as const;

export type LessonKind = (typeof LESSON_KINDS)[number];
