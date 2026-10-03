import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BookOpen, FilterX, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlatformLessonsSkeleton } from '@/components/ai/PlatformLessonsSkeleton';
import { MotirAiError } from '@/lib/ai/errors';
import type { PlatformLessonListDTO, PlatformLessonListFilters } from '@/lib/dto/platformLessons';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { platformLessonsService } from '@/lib/services/platformLessonsService';
import { LessonFilters } from './_components/LessonFilters';
import { FILTER_KEYS } from './_components/filterKeys';
import { LessonsTable } from './_components/LessonsTable';
import { LessonsUnavailable } from './_components/LessonsUnavailable';
import { RetentionCard } from './_components/RetentionCard';

/**
 * The console's PLANNING LESSONS page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-02 (Planning lessons), card MOTIR-1411, story MOTIR-1408.
 *
 * Every organisation's planning lessons beside the global corpus, filtered and
 * cursor-paged by motir-ai. Every staff role reads; a non-staff request never
 * reaches this file — the `(admin)` layout answers the app's 404 first. Loading
 * a page is a cross-tenant read and writes one `estate.read` row (the service).
 *
 * ⚠️ THERE IS NO TOTAL. The API is cursor-paged; the pager says "Page {n}" and
 * Previous walks back through the cursors this URL has already carried
 * (`trail`), so a deep link and Back agree.
 */

export const metadata: Metadata = { title: 'Planning lessons' };

/** Never cached — a lesson switched off a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function toFilters(params: SearchParams): PlatformLessonListFilters {
  const scope = one(params['scope']);
  const state = one(params['state']);
  return {
    ...(one(params['q']) ? { q: one(params['q'])! } : {}),
    ...(scope === 'global' || scope === 'tenant' ? { scope } : {}),
    ...(one(params['type']) ? { mistakeType: one(params['type'])! } : {}),
    ...(one(params['category']) ? { category: one(params['category'])! } : {}),
    ...(one(params['org']) ? { organizationId: one(params['org'])! } : {}),
    ...(state === 'on' ? { enabled: true } : state === 'off' ? { enabled: false } : {}),
    ...(one(params['cursor']) ? { cursor: one(params['cursor'])! } : {}),
  };
}

export default async function AdminPlanningLessonsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin.lessons');
  const params = await searchParams;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>
            <strong className="font-semibold text-(--el-text-strong)">
              {t('readAuditedLead')}
            </strong>{' '}
            {t('readAuditedBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (CLAUDE.md's
          boundary rule); the header above paints at once (Panel 3a). */}
      <Suspense
        key={JSON.stringify(params)}
        fallback={<PlatformLessonsSkeleton title={t('card.title')} />}
      >
        <LessonsSection principal={principal} params={params} />
      </Suspense>
    </div>
  );
}

async function LessonsSection({
  principal,
  params,
}: {
  principal: PlatformPrincipal;
  params: SearchParams;
}) {
  const t = await getTranslations('platformAdmin.lessons');
  const filters = toFilters(params);
  let list: PlatformLessonListDTO;
  try {
    list = await platformLessonsService.list(principal, filters);
  } catch (err) {
    // Any motir-ai failure is the unavailable state (Panel 3c); anything else is a bug.
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planning lessons could not be read', err);
    return <LessonsUnavailable />;
  }

  const filtered = FILTER_KEYS.some((key) => one(params[key]));
  const trail = (one(params['trail']) ?? '').split(',').filter(Boolean);
  const cursor = one(params['cursor']);
  const pageNumber = cursor ? trail.length + 2 : 1;

  let body: React.ReactNode;
  if (list.rows.length > 0) {
    body = <LessonsTable rows={list.rows} retentionDays={list.retentionDays} />;
  } else if (filtered || cursor) {
    body = (
      <EmptyState
        data-testid="planning-lessons-no-match"
        icon={<FilterX />}
        title={t('noMatch.title')}
        description={t('noMatch.body')}
        action={
          <Link
            href="/admin/planning-lessons"
            className="font-sans text-sm text-(--el-link) underline-offset-2 hover:underline"
          >
            {t('noMatch.action')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <EmptyState
        data-testid="planning-lessons-empty"
        icon={<BookOpen />}
        title={t('empty.title')}
        description={t('empty.body')}
      />
    );
  }

  const showPager = pageNumber > 1 || list.nextCursor !== null;

  return (
    <>
      <RetentionCard retention={list.retention} />
      <Card
        data-testid="planning-lessons-card"
        header={
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              <BookOpen className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('card.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">{t('card.subtitle')}</p>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <LessonFilters organizations={list.organizations} categories={list.categories} />
          {body}
          {showPager ? (
            <Pager
              params={params}
              pageNumber={pageNumber}
              trail={trail}
              cursor={cursor}
              nextCursor={list.nextCursor}
            />
          ) : null}
        </div>
      </Card>
    </>
  );
}

async function Pager({
  params,
  pageNumber,
  trail,
  cursor,
  nextCursor,
}: {
  params: SearchParams;
  pageNumber: number;
  trail: string[];
  cursor: string | undefined;
  nextCursor: string | null;
}) {
  const t = await getTranslations('platformAdmin.lessons.pager');
  const href = (nextCursorValue: string | undefined, nextTrail: string[]) => {
    const url = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = one(params[key]);
      if (value) url.set(key, value);
    }
    if (nextCursorValue) url.set('cursor', nextCursorValue);
    if (nextCursorValue && nextTrail.length > 0) url.set('trail', nextTrail.join(','));
    const qs = url.toString();
    return qs ? `/admin/planning-lessons?${qs}` : '/admin/planning-lessons';
  };
  const previous = pageNumber > 1 ? href(trail[trail.length - 1], trail.slice(0, -1)) : null;
  const next = nextCursor ? href(nextCursor, cursor ? [...trail, cursor] : trail) : null;
  const link =
    'inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x-sm) font-sans text-sm text-(--el-text) hover:bg-(--el-surface-soft)';
  return (
    <nav
      aria-label={t('label')}
      data-testid="planning-lessons-pager"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border-soft) pt-3 font-sans text-xs text-(--el-text-secondary)"
    >
      <span>{t('label')}</span>
      <div className="flex items-center gap-2">
        <span className="text-(--el-text)">{t('page', { n: pageNumber })}</span>
        {previous ? (
          <Link className={link} href={previous}>
            {t('previous')}
          </Link>
        ) : null}
        {next ? (
          <Link className={link} href={next}>
            {t('next')}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
