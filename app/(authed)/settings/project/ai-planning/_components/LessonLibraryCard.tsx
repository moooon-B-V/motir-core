import Link from 'next/link';
import { ArrowRight, GraduationCap } from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// THE DOOR (Subtask MOTIR-3338) — `design/ai-settings/ai-planning-lessons.mock.html`
// panel 0, design-notes.md §L3.
//
// A fourth card on the page a reader is already on, showing the three most
// recent takeaways and a link to the library. A PREVIEW, not the list: the
// library is paged and unbounded (`ADMIN_PAGE_DEFAULT = 50`) and a settings page
// with a Save footer is not a place to page through one.
//
// ⚠️ IT CARRIES NO FOOTER, and that is the asset's one refinement of MOTIR-914's
// §4. That section says the Save/Cancel footer "appears once, on the last card";
// this card is READ-ONLY, so the rule reads "the last EDITABLE card" — which is
// still `Planner`, so nothing moved. A Save button rendered beneath a list would
// appear to govern the list.
//
// ⚠️ AND THE PAGE DECIDES WHETHER TO RENDER IT AT ALL — see the `lesson:view`
// check in `page.tsx`. Hiding is presentation and never protection; the
// destination asserts the same key before it fetches anything.

export interface LessonLibraryCardCopy {
  title: string;
  subtitle: string;
  viewAll: string;
  unavailableTitle: string;
  unavailableBody: string;
}

/** How many takeaways the preview shows. The asset draws three (§L3). */
export const LESSON_PREVIEW_COUNT = 3;

export function LessonLibraryCard({
  lessons,
  available,
  href,
  copy,
  formatWhen,
}: {
  /** The PREVIEW rows — at most {@link LESSON_PREVIEW_COUNT} are drawn. */
  lessons: ProjectLessonDTO[];
  /** False when motir-ai could not be reached — the section goes quiet (MOTIR-3337). */
  available: boolean;
  href: string;
  /**
   * ⚠️ `viewAll` is interpolated by the CALLER, with the LIBRARY's total — not
   * with `lessons.length`, which is the preview and is capped at three. "View
   * all 3 lessons" on a project with twelve is the failure this note exists to
   * stop; it reads perfectly and is wrong.
   */
  copy: LessonLibraryCardCopy;
  formatWhen: (iso: string) => string;
}) {
  return (
    <SettingsCard
      icon={<GraduationCap className="size-[17px]" aria-hidden />}
      title={copy.title}
      subtitle={copy.subtitle}
      testId="lesson-library-card"
    >
      {!available ? (
        // The DEGRADED face. An unrelated motir-ai outage costs this section its
        // content and never the three settings groups above it (MOTIR-3337).
        <div role="status" className="flex flex-col gap-1">
          <p className="text-sm font-medium text-(--el-text)">{copy.unavailableTitle}</p>
          <p className="text-(--el-text-secondary) text-xs">{copy.unavailableBody}</p>
        </div>
      ) : (
        <>
          {lessons.length > 0 && (
            <ul className="-mt-1 flex flex-col">
              {lessons.slice(0, LESSON_PREVIEW_COUNT).map((lesson) => (
                <li
                  key={lesson.id}
                  data-testid="lesson-preview-row"
                  className="border-(--el-border-soft) flex items-baseline gap-2.5 border-b py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 text-sm text-(--el-text)">{lesson.title}</span>
                  <span className="text-(--el-text-secondary) shrink-0 text-xs tabular-nums">
                    {formatWhen(lesson.lastOccurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={href}
            data-testid="lesson-library-link"
            className="text-(--el-link) inline-flex items-center gap-1.5 self-start text-sm font-medium"
          >
            {copy.viewAll}
            <ArrowRight className="size-[15px]" aria-hidden />
          </Link>
        </>
      )}
    </SettingsCard>
  );
}
