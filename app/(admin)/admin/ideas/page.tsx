import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FilterX, Info, Lightbulb } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import type { StaffIdeaListDto, StaffIdeaTagDto } from '@/lib/dto/ideas';
import { consoleIdeaActor } from '@/lib/ideas/consoleActor';
import { type PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { IdeaFilters } from './_components/IdeaFilters';
import { IdeasSkeleton } from './_components/IdeasSkeleton';
import { IdeasTable } from './_components/IdeasTable';
import { IdeasUnavailable } from './_components/IdeasUnavailable';
import {
  ideaListHref,
  isFilteredView,
  readIdeaListView,
  toIdeaListQuery,
  type IdeaListView,
  type IdeaSearchParams,
} from './_components/ideaListQuery';

/**
 * The console's IDEAS page — design `platform-admin/design-notes.md` § Ideas
 * (MOTIR-7679), card MOTIR-7680, story MOTIR-7664.
 *
 * Every idea in the store, active and retired, newest first and keyset-paged by
 * `ideasAdminService.listForStaff`, narrowed by status, kind, category, tag and
 * text — all in the URL, so a reload and a shared link agree. Every staff role
 * reads; a non-staff request gets the app's 404 from this page's gate as from
 * the layout's (`pageGate.ts` says why both must answer it, MOTIR-7613).
 *
 * ⚠️ THERE IS NO TOTAL. The service pages by cursor and never counts, so the
 * card says how many are SHOWN and the pager offers the first page and the
 * next one — the design's pager, not a page-number walk.
 */

export const metadata: Metadata = { title: 'Ideas' };

/** Never cached — an idea retired a minute ago must show as retired on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminIdeasPage({
  searchParams,
}: {
  searchParams: Promise<IdeaSearchParams>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.ideas');
  const view = readIdeaListView(await searchParams);

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
            <strong className="font-semibold text-(--el-text-strong)">{t('auditLead')}</strong>{' '}
            {t('auditBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (CLAUDE.md's
          boundary rule); the header above paints at once (Panel 3a). */}
      <Suspense key={ideaListHref(view)} fallback={<IdeasSkeleton title={t('card.title')} />}>
        <IdeasSection principal={principal} view={view} />
      </Suspense>
    </div>
  );
}

async function IdeasSection({
  principal,
  view,
}: {
  principal: PlatformPrincipal;
  view: IdeaListView;
}) {
  const t = await getTranslations('platformAdmin.ideas');
  const actor = consoleIdeaActor(principal);
  let list: StaffIdeaListDto;
  let tags: StaffIdeaTagDto[];
  try {
    // Both reads settle before either outcome is used: a `Promise.all` would
    // reject on the list read and return the error card while the tag query was
    // still running on the database (MOTIR-7795).
    [list, tags] = await allSettledOrThrow<[StaffIdeaListDto, StaffIdeaTagDto[]]>([
      ideasAdminService.listForStaff(actor, toIdeaListQuery(view)),
      ideasAdminService.listTags(actor),
    ]);
  } catch (err) {
    // Any failure to read the store is the error state (Panel 3c) — a cursor
    // this URL carries but the service did not issue included: the card offers
    // Retry and the rail, not a crash.
    console.error('[admin] ideas could not be read', err);
    return <IdeasUnavailable />;
  }

  const filtered = isFilteredView(view);

  let body: React.ReactNode;
  if (list.items.length > 0) {
    body = <IdeasTable ideas={list.items} />;
  } else if (filtered || view.cursor) {
    body = (
      <EmptyState
        data-testid="ideas-no-match"
        icon={<FilterX />}
        title={t('emptyFilter.title')}
        action={
          <Link
            href={ideaListHref({})}
            className="font-sans text-sm text-(--el-link) underline-offset-2 hover:underline"
          >
            {t('emptyFilter.action')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <EmptyState
        data-testid="ideas-empty"
        icon={<Lightbulb />}
        title={t('empty.title')}
        description={t('empty.body')}
      />
    );
  }

  const showPager = Boolean(view.cursor) || list.nextCursor !== null;

  return (
    <Card
      data-testid="ideas-card"
      header={
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-yellow) text-(--el-text-strong)"
          >
            <Lightbulb className="h-4 w-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('card.title')}</h2>
            {list.items.length > 0 ? (
              <p data-testid="ideas-count" className="font-sans text-xs text-(--el-text-secondary)">
                {t('card.count', { count: list.items.length })}
              </p>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <IdeaFilters view={view} tags={tags.map(({ slug, label }) => ({ slug, label }))} />
        {body}
        {showPager ? <Pager view={view} nextCursor={list.nextCursor} /> : null}
      </div>
    </Card>
  );
}

async function Pager({ view, nextCursor }: { view: IdeaListView; nextCursor: string | null }) {
  const t = await getTranslations('platformAdmin.ideas.pager');
  const { cursor, ...filters } = view;
  const link =
    'inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x-sm) font-sans text-sm text-(--el-text) hover:bg-(--el-surface-soft)';
  return (
    <nav
      aria-label={t('label')}
      data-testid="ideas-pager"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border-soft) pt-3 font-sans text-xs text-(--el-text-secondary)"
    >
      <span>{t('note')}</span>
      <div className="flex items-center gap-2">
        {cursor ? (
          <Link className={link} href={ideaListHref(filters)}>
            {t('first')}
          </Link>
        ) : null}
        {nextCursor ? (
          <Link className={link} href={ideaListHref({ ...filters, cursor: nextCursor })}>
            {t('next')}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
