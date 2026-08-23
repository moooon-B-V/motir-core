import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, GraduationCap } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { guardSettingsPage } from '../../_guard';
import { canManageLessonLibrary, guardLessonLibrary } from '../_components/lessonAccess';
import { LessonRow } from '../_components/LessonRow';
import { lessonApplyCopy, lessonRowCopy } from '../_components/lessonCopy';
import { LessonApplyControl } from '../_components/LessonApplyControl';

// THE LESSON LIBRARY — `/settings/project/ai-planning/lessons` (Subtask
// MOTIR-3338), the surface `design/ai-settings/ai-planning-lessons.mock.html`
// panels 1, 3 and 5 specify, with design-notes.md §§L2–L6 as the spec.
//
// A DRILL-DOWN of the `ai-planning` registry entry (`nestedRoutes`), the same
// shape `roles/[roleKey]` uses: no rail row of its own, and the AI-planning row
// stays active while you are here.
//
// TWO gates, and they ask different questions:
//   * `guardSettingsPage('ai-planning')` — may you open this settings area at
//     all (`ai:configure`, looked up from the registry, never re-declared).
//   * `lesson:view` — may you read what this project taught its planner. The
//     SERVICE asserts it, before any call to motir-ai (MOTIR-3337), so a
//     refusal costs no upstream request. This page only renders the refusal.

export default async function ProjectLessonsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/settings/project/ai-planning');

  const refused = await guardSettingsPage('ai-planning', ctx);
  if (refused) return refused;

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  // The SECOND gate, after the area's own. Its key lives in one place
  // (`_components/lessonAccess`) so the door and both destinations cannot come
  // apart — see the note there.
  const noLessons = await guardLessonLibrary(ctx);
  if (noLessons) return noLessons;

  const [page, format, mayManage] = await Promise.all([
    projectLessonsService.listLessons(ctx.projectId, wsCtx),
    getFormatter(),
    // ⚠️ The SECOND key (MOTIR-3336): reading the library and changing what the
    // planner is told are different permissions. Resolved here and passed down
    // — the control does no permission reasoning of its own, and the route
    // refuses independently whatever this says.
    canManageLessonLibrary(ctx),
  ]);
  const copy = lessonRowCopy(t, (iso) => format.relativeTime(new Date(iso)));

  return (
    <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
      <div>
        <Link
          href="/settings/project/ai-planning"
          data-testid="lessons-back"
          className="text-(--el-link) mb-2.5 inline-flex items-center gap-1.5 text-sm font-medium"
        >
          <ChevronLeft className="size-[15px]" aria-hidden />
          {t('aiPlanning.lessons.backToAiPlanning')}
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
            {t('aiPlanning.lessons.pageTitle')}
          </h1>
          <p className="text-(--el-text-secondary) font-sans text-sm">
            {t('aiPlanning.lessons.pageDescription')}
          </p>
        </header>
      </div>

      {page.available && page.total > 0 && (
        <p className="text-(--el-text-secondary) text-sm" data-testid="lessons-count">
          {t('aiPlanning.lessons.count', { total: page.total, applied: page.applied })}
        </p>
      )}

      <div
        data-surface="card"
        className="bg-(--el-card) border-(--el-border) shadow-(--shadow-card) flex flex-col overflow-hidden rounded-(--radius-card) border"
      >
        {!page.available ? (
          <EmptyState
            icon={<GraduationCap aria-hidden />}
            title={t('aiPlanning.lessons.unavailableTitle')}
            description={t('aiPlanning.lessons.unavailableBody')}
          />
        ) : page.lessons.length === 0 ? (
          // THE EMPTY STATE (§L5) — the common case for weeks, and the moment
          // the feature explains itself. Written as an explanation: what would
          // appear here, when, and where the switch that stops it lives.
          <EmptyState
            icon={<GraduationCap aria-hidden />}
            title={t('aiPlanning.lessons.emptyTitle')}
            description={
              <>
                <span className="block">{t('aiPlanning.lessons.emptyBody')}</span>
                <span className="mt-2.5 block">{t('aiPlanning.lessons.emptyRecording')}</span>
              </>
            }
          />
        ) : (
          page.lessons.map((lesson) => (
            <LessonRow
              key={lesson.id}
              lesson={lesson}
              href={`/settings/project/ai-planning/lessons/${lesson.id}`}
              copy={copy}
              action={
                mayManage ? (
                  <LessonApplyControl
                    lesson={lesson}
                    projectKey={ctx.project.identifier}
                    // Resolved PER LESSON — the accessible name carries the
                    // takeaway and the badge carries that row's own window, and
                    // neither may cross the client boundary as a function.
                    copy={lessonApplyCopy(t, lesson)}
                    revealOnHover
                  />
                ) : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
