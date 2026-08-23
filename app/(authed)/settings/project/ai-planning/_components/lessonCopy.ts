import type { LessonRowCopy } from './LessonRow';

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
