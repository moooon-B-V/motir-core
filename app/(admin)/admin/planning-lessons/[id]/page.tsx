import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronLeft, History } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { MotirAiError, PlatformLessonNotFoundError } from '@/lib/ai/errors';
import type { PlatformLessonChangeDTO, PlatformLessonDetailDTO } from '@/lib/dto/platformLessons';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { platformLessonsService } from '@/lib/services/platformLessonsService';
import { LessonCurate } from '../_components/LessonCurate';
import { LessonsUnavailable } from '../_components/LessonsUnavailable';

/**
 * One PLANNING LESSON — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-02 (Planning lessons) Panels 4–9, card MOTIR-1411.
 *
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no `<Suspense>` above it: a lesson motir-ai does not have
 * is the app's 404 with a real 404 status (CLAUDE.md's boundary rule). Opening
 * a detail is a cross-tenant read and writes one `estate.read` row.
 */

export const metadata: Metadata = { title: 'Planning lesson' };

export const dynamic = 'force-dynamic';

export default async function AdminPlanningLessonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requirePlatformStaff('support');
  const { id } = await params;
  const t = await getTranslations('platformAdmin.lessons');

  let lesson: PlatformLessonDetailDTO;
  try {
    lesson = await platformLessonsService.get(principal, id);
  } catch (err) {
    if (err instanceof PlatformLessonNotFoundError) notFound();
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planning lesson could not be read', { id }, err);
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <BackLink label={t('detail.back')} />
        <LessonsUnavailable />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <BackLink label={t('detail.back')} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <LessonCurate lesson={lesson} />
        <div className="flex flex-col gap-4 lg:pt-[4.5rem]">
          <Provenance lesson={lesson} />
          <Occurrences lesson={lesson} />
          <StaffHistory lesson={lesson} />
        </div>
      </div>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/admin/planning-lessons"
      className="inline-flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
    >
      <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

async function Provenance({ lesson }: { lesson: PlatformLessonDetailDTO }) {
  const t = await getTranslations('platformAdmin.lessons');
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const rows: [string, React.ReactNode][] = [];
  if (lesson.owner) {
    rows.push([t('detail.organisation'), lesson.owner.organizationName ?? t('owner.unknownOrg')]);
    rows.push([
      t('detail.workspaceProject'),
      <span key="wp" className="font-mono text-xs text-(--el-text-identifier)">
        {[lesson.owner.workspaceName, lesson.owner.projectName].filter(Boolean).join(' / ') || '—'}
      </span>,
    ]);
  } else {
    rows.push([t('detail.organisation'), t('owner.global')]);
  }
  rows.push([
    t('detail.source'),
    <span key="src" className="font-mono text-xs text-(--el-text-identifier)">
      {lesson.sourceRef ?? '—'}
    </span>,
  ]);
  rows.push([t('detail.captured'), date(lesson.createdAt)]);
  rows.push([
    t('detail.recurred'),
    `${t('recur', { n: lesson.recurrenceCount })} · ${t('recurLast', { when: date(lesson.lastOccurredAt) })}`,
  ]);
  return (
    <Card
      data-testid="lesson-provenance"
      header={
        <h2 className="font-sans text-sm font-semibold text-(--el-text)">
          {t('detail.provenance')}
        </h2>
      }
    >
      <dl className="flex flex-col gap-2 font-sans text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
            <dd className="text-(--el-text)">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

async function Occurrences({ lesson }: { lesson: PlatformLessonDetailDTO }) {
  const t = await getTranslations('platformAdmin.lessons.detail');
  const format = await getFormatter();
  return (
    <Card
      data-testid="lesson-occurrences"
      header={
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('occurrences')}</h2>
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('occurrencesSub')}
          </span>
        </div>
      }
    >
      {lesson.occurrences.length === 0 ? (
        <p className="font-sans text-xs text-(--el-text-secondary)">{t('noOccurrences')}</p>
      ) : (
        <ul className="flex flex-col gap-2 font-sans text-xs">
          {lesson.occurrences.map((o) => (
            <li key={`${o.occurrenceRef}-${o.at}`} className="flex flex-col gap-0.5">
              <span className="font-mono text-(--el-text-identifier)">{o.occurrenceRef}</span>
              <span className="text-(--el-text-secondary)">
                {o.source} · {format.dateTime(new Date(o.at), { dateStyle: 'medium' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

async function StaffHistory({ lesson }: { lesson: PlatformLessonDetailDTO }) {
  const t = await getTranslations('platformAdmin.lessons');
  const format = await getFormatter();
  const value = (v: unknown) =>
    Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '—' : String(v);
  const fieldLabel = (change: PlatformLessonChangeDTO) =>
    t.has(`field.${change.field}` as 'field.title')
      ? t(`field.${change.field}` as 'field.title')
      : change.field;
  return (
    <Card
      data-testid="lesson-history"
      header={
        <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
          <History aria-hidden className="h-4 w-4 text-(--el-info)" />
          {t('detail.history')}
        </h2>
      }
    >
      {lesson.history.length === 0 ? (
        <p className="font-sans text-xs text-(--el-text-secondary)">{t('detail.noHistory')}</p>
      ) : (
        <ol className="flex flex-col gap-3 font-sans text-xs">
          {lesson.history.map((entry) => (
            <li key={entry.id} data-testid="lesson-history-entry" className="flex flex-col gap-1">
              <span className="text-sm font-medium text-(--el-text)">
                {t(`historyAction.${entry.action}`)}
              </span>
              {entry.changes
                .filter((c) => c.field !== 'tenant')
                .map((c) => (
                  <span key={c.field} className="text-(--el-text-secondary)">
                    {fieldLabel(c)}: <s className="text-(--el-text-secondary)">{value(c.before)}</s>{' '}
                    → <span className="text-(--el-text)">{value(c.after)}</span>
                  </span>
                ))}
              <span className="text-(--el-text-secondary)">
                {t('detail.historyBy', {
                  who: entry.actorName ?? t('detail.unknownUser'),
                  when: format.dateTime(new Date(entry.at), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </span>
              {entry.reason ? <span className="text-(--el-text)">“{entry.reason}”</span> : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
