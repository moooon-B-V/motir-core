import type { LessonRowCopy } from './LessonRow';
import type { LessonApplyCopy } from './LessonApplyControl';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// The row's copy, resolved ONCE and handed to every consumer (Subtask
// MOTIR-3338). The list and the door card render the same lesson, so the
// pluralisation and the date phrasing live in one place rather than being
// re-derived beside each surface.
//
// `seen once` / `seen twice` are their own strings rather than a plural rule:
// the design fixes those two words (§L9), and "seen 1 times" is the failure a
// generic rule produces.
export function lessonRowCopy(
  t: (key: string, values?: Record<string, string | number>) => string,
  formatWhen: (iso: string) => string,
): LessonRowCopy {
  return {
    lastSeen: (iso) => t('aiPlanning.lessons.lastSeen', { when: formatWhen(iso) }),
    seen: (count) =>
      count === 1
        ? t('aiPlanning.lessons.seenOnce')
        : count === 2
          ? t('aiPlanning.lessons.seenTwice')
          : t('aiPlanning.lessons.seenTimes', { count }),
    everyCard: t('aiPlanning.lessons.everyCard'),
    notApplied: t('aiPlanning.lessons.notApplied'),
    notRecurred: (days) => t('aiPlanning.lessons.notRecurred', { days }),
  };
}

// The APPLY CONTROL's copy (Subtask MOTIR-3346), resolved once per surface and
// handed to the client island — the same shape as `lessonRowCopy` above, and for
// the same reason: the list and the detail render the same decision, so the
// wording lives in one place instead of beside each caller.
//
// It carries the two BADGE labels as well as the button's, because the island
// owns the acted-on row's badge (see `LessonApplyControl`) and cannot reach a
// server translator after it mounts.
//
// ⚠️ IT TAKES THE LESSON, and returns only STRINGS. `lessonRowCopy` above hands
// back FUNCTIONS, which is fine because its consumer is a Server Component; this
// one's consumer is a `'use client'` island, and a function prop across that
// boundary throws *"Functions cannot be passed directly to Client Components"* —
// a 500 on the route, not a type error. Both interpolations are per-lesson
// constants, so they are resolved here instead.
export function lessonApplyCopy(
  t: (key: string, values?: Record<string, string | number>) => string,
  lesson: ProjectLessonDTO,
): LessonApplyCopy {
  return {
    stopApplying: t('aiPlanning.lessons.stopApplying'),
    applyAgain: t('aiPlanning.lessons.applyAgain'),
    stopApplyingNamed: t('aiPlanning.lessons.stopApplyingNamed', { title: lesson.title }),
    applyAgainNamed: t('aiPlanning.lessons.applyAgainNamed', { title: lesson.title }),
    errorNotFound: t('aiPlanning.lessons.errorNotFound'),
    errorForbidden: t('aiPlanning.lessons.errorForbidden'),
    errorUnavailable: t('aiPlanning.lessons.errorUnavailable'),
    errorGeneric: t('aiPlanning.lessons.errorGeneric'),
    notApplied: t('aiPlanning.lessons.notApplied'),
    notRecurred: t('aiPlanning.lessons.notRecurred', { days: lesson.retentionDays }),
  };
}
