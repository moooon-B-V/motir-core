import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { guardSettingsPage } from '../../../_guard';
import { canManageLessonLibrary, guardLessonLibrary } from '../../_components/lessonAccess';
import { AxisChip, EveryCardChip, NotAppliedBadge } from '../../_components/LessonRow';
import { lessonApplyCopy, lessonRowCopy } from '../../_components/lessonCopy';
import { LessonDetailStatus } from '../../_components/LessonDetailStatus';

// ONE LESSON, IN FULL — `/settings/project/ai-planning/lessons/[lessonId]`
// (Subtask MOTIR-3338), the surface `ai-planning-lessons.mock.html` panel 4 and
// design-notes.md §L7 specify.
//
// The screen that answers *why is the planner telling me this?*, so it carries
// the REASONING rather than a summary of it: all four text fields, under labels
// in the reader's words — What happened · Why it matters · How to apply it ·
// Where it came from — never the column names.
//
// Its own ROUTE rather than a modal, because a lesson is the kind of thing one
// person sends another (§L7). The second declared drill-down of the
// `ai-planning` entry.
//
// ⚠️ A lesson belonging to ANOTHER project is `notFound()`, exactly as an
// unknown id is: motir-ai raises the same `not_found` for both and nothing on
// this side tries to tell them apart (MOTIR-3337).

interface RouteParams {
  params: Promise<{ lessonId: string }>;
}

export default async function ProjectLessonPage({ params }: RouteParams) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/settings/project/ai-planning');

  const refused = await guardSettingsPage('ai-planning', ctx);
  if (refused) return refused;

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const noLessons = await guardLessonLibrary(ctx);
  if (noLessons) return noLessons;

  const { lessonId } = await params;
  const [lesson, format, mayManage] = await Promise.all([
    projectLessonsService.getLesson(ctx.projectId, wsCtx, lessonId),
    getFormatter(),
    canManageLessonLibrary(ctx),
  ]);
  if (!lesson) notFound();

  const copy = lessonRowCopy(t, (iso) => format.relativeTime(new Date(iso)));
  const applyCopy = lessonApplyCopy(t, lesson);
  const axes = [
    ...lesson.kinds.map((value) => ({ axis: 'kind', value })),
    ...lesson.types.map((value) => ({ axis: 'type', value })),
    ...lesson.phases.map((value) => ({ axis: 'phase', value })),
  ];
  const sections = [
    { label: t('aiPlanning.lessons.sectionHappened'), body: lesson.body },
    { label: t('aiPlanning.lessons.sectionMatters'), body: lesson.why },
    { label: t('aiPlanning.lessons.sectionApply'), body: lesson.howToApply },
  ];
  // The §L7 callout — the SAME `.callout` box the AI-planning page already uses
  // for its guardrail sentence; no new primitive. Built once so the two arms
  // below cannot describe "Motir is applying this" differently.
  const applyingCallout = (
    <div
      role="status"
      data-testid="lesson-applying"
      className="bg-(--el-tint-sky) flex items-start gap-2.5 rounded-(--radius-card) px-4 py-3"
    >
      <ShieldCheck className="text-(--el-text-strong) mt-px size-4 shrink-0" aria-hidden />
      <p className="text-(--el-text-strong) text-sm">
        <strong className="font-semibold">{t('aiPlanning.lessons.applyingTitle')}</strong>{' '}
        {t('aiPlanning.lessons.applyingBody')}
      </p>
    </div>
  );
  const facts = [
    [t('aiPlanning.lessons.factFirstRecorded'), format.dateTime(new Date(lesson.createdAt))],
    [t('aiPlanning.lessons.factLastSeen'), format.relativeTime(new Date(lesson.lastOccurredAt))],
    [t('aiPlanning.lessons.factTimesSeen'), String(lesson.recurrenceCount)],
  ] as const;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <div>
        <Link
          href="/settings/project/ai-planning/lessons"
          data-testid="lesson-back"
          className="text-(--el-link) mb-2.5 inline-flex items-center gap-1.5 text-sm font-medium"
        >
          <ChevronLeft className="size-[15px]" aria-hidden />
          {t('aiPlanning.lessons.backToLessons')}
        </Link>
        <header className="flex flex-col gap-2.5">
          <h1 className="max-w-[34ch] font-serif text-[26px] leading-tight font-semibold text-(--el-text)">
            {lesson.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            {axes.length === 0 ? (
              <EveryCardChip label={copy.everyCard} />
            ) : (
              axes.map((a) => (
                <AxisChip key={`${a.axis}:${a.value}`} axis={a.axis} value={a.value} />
              ))
            )}
          </div>
        </header>
      </div>

      {/* THE LIVE-STATE REGION — the §L7 status callout, the not-applied badge
          and the action, which all render ONE fact: is Motir applying this.
          When the reader may act, they are one client island so the acted-on
          lesson's state comes from the mutation RESPONSE (the page-state
          contract) rather than from a re-read that would revert it. A reader who
          cannot act gets the same markup, server-rendered — there is nothing to
          keep in sync. */}
      {mayManage ? (
        <LessonDetailStatus
          lesson={lesson}
          projectKey={ctx.project.identifier}
          copy={applyCopy}
          retireLabel={t('aiPlanning.lessons.stopApplyingLesson')}
          applyingCallout={applyingCallout}
          notAppliedLabel={copy.notApplied}
          notRecurredLabel={copy.notRecurred(lesson.retentionDays)}
        />
      ) : lesson.injectionBlock === null ? (
        applyingCallout
      ) : (
        <div data-testid="lesson-not-applied">
          <NotAppliedBadge
            block={lesson.injectionBlock}
            label={
              lesson.injectionBlock === 'disabled'
                ? copy.notApplied
                : copy.notRecurred(lesson.retentionDays)
            }
          />
        </div>
      )}

      {sections.map((section) => (
        <section key={section.label} className="flex flex-col gap-1.5">
          <h2 className="text-(--el-text-secondary) text-xs font-semibold tracking-wide uppercase">
            {section.label}
          </h2>
          <p className="max-w-[68ch] text-sm leading-relaxed text-(--el-text)">{section.body}</p>
        </section>
      ))}

      <section className="flex flex-col gap-1.5">
        <h2 className="text-(--el-text-secondary) text-xs font-semibold tracking-wide uppercase">
          {t('aiPlanning.lessons.sectionProvenance')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-(--el-text-secondary)">{label}</dt>
              <dd className="m-0 tabular-nums text-(--el-text)">{value}</dd>
            </div>
          ))}
          {/* WHO switched it off (or kept it) and WHEN — the audit the write
              records, and the question the surface promised to answer. Absent
              when no decision stands, because there is nothing to say. */}
          {lesson.humanOverrideBy && lesson.humanOverrideAt && (
            <div className="contents">
              <dt className="text-(--el-text-secondary)">
                {lesson.humanOverride === 'exempt'
                  ? t('aiPlanning.lessons.factKeptBy')
                  : t('aiPlanning.lessons.factSwitchedOffBy')}
              </dt>
              <dd className="m-0 text-(--el-text)" data-testid="lesson-override-audit">
                {t(
                  lesson.humanOverride === 'exempt'
                    ? 'aiPlanning.lessons.keptBy'
                    : 'aiPlanning.lessons.switchedOffBy',
                  {
                    who: lesson.humanOverrideBy,
                    when: format.dateTime(new Date(lesson.humanOverrideAt)),
                  },
                )}
              </dd>
            </div>
          )}
          {lesson.sourceRef && (
            <div className="contents">
              <dt className="text-(--el-text-secondary)">
                {t('aiPlanning.lessons.factRecordedFrom')}
              </dt>
              <dd className="m-0 text-(--el-text)">
                <code className="bg-(--el-muted) rounded-(--radius-control) px-1.5 py-0.5 font-mono text-xs">
                  {lesson.sourceRef}
                </code>
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
