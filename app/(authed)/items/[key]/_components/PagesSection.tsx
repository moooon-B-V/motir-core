'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AtSign,
  ChevronRight,
  Folder,
  Link2,
  NotebookText,
  Rows3,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { foldSegments, type BreadcrumbSegment } from '@/components/pages/tree/PageBreadcrumb';
import { cn } from '@/lib/utils/cn';
import type {
  PageLinkSourceDto,
  WorkItemPageLinkPlaceDto,
  WorkItemPageLinkRowDto,
  WorkItemPagesDto,
} from '@/lib/dto/pageLinks';
import { fetchWorkItemPages } from '@/lib/workItems/pageLinksClient';
import { ContentSectionCard } from './ContentSectionCard';
import { PAGES_SECTION_ID } from './decisionAnchor';

// THE PAGES SECTION on the work item page (Story MOTIR-7565 · MOTIR-7575), per
// `design/work-items/item--pages-section.mock.html` + design-notes § *The Pages
// section* (MOTIR-7569): which pages point at this work item, one row per page.
//
// WHERE: tier 3, the lower late half, first — between Plans and Attachments. It
// is mounted inside `LateLowerSections`, so it arrives with the late stack's one
// settle, and ONLY for a reader holding `page:view` who is not a Visitor: a
// withheld reader gets no section, no skeleton and no read (panel 6). The gate is
// the caller's; this component never asks.
//
// A CLIENT ISLAND because it owns its rows: it reads the first page on mount from
// `GET /api/work-items/<id>/pages` and Show more pages appends the next cursor's.
// Nothing another mutation on this page changes is read here (a page's links are
// written from the page), so no refetch tick is owed.
//
// THE ROW is `RelationshipsPanel`'s `LinkRow` grammar: an `li` holding the page's
// link, controls OUTSIDE the link (the Unlink slot MOTIR-7567 will fill renders
// nothing here and holds no space). The PLACE is `PageBreadcrumb`'s vocabulary as
// a LABEL — the whole row is a link and a link cannot nest in a link.
//
// ⚠️ THE HEADER'S "+ Link page" DOOR IS NOT RENDERED. Its behaviour belongs to
// story MOTIR-7567, which is not built, and a button that does nothing is worse
// than none. `headerAction` is the slot it will take (`ContentSectionCard`'s
// `headerRight`, as Development's Link pull request door does).

export interface PagesSectionProps {
  /** The item's id — the Pages route is keyed on it. */
  workItemId: string;
  /** The `PROD-N` key, for the list's accessible name. */
  identifier: string;
  /** The header's far end — reserved for MOTIR-7567's Link page door. */
  headerAction?: ReactNode;
}

/** The sources in the design's fixed order: Mentioned, Embedded, Linked, then
 *  the work item's own tags (MOTIR-7696). */
const SOURCE_ORDER: readonly PageLinkSourceDto[] = [
  'mention',
  'embed',
  'manual',
  'description',
  'explanation',
];

type IssueViewsT = ReturnType<typeof useTranslations<'issueViews'>>;

/** A source's label and glyph — TOTAL over the closed union; a fourth source
 *  turns the `never` red. */
export function sourceChip(
  source: PageLinkSourceDto,
  t: IssueViewsT,
): { label: string; Icon: LucideIcon } {
  switch (source) {
    case 'mention':
      return { label: t('pagesSourceMention'), Icon: AtSign };
    case 'embed':
      return { label: t('pagesSourceEmbed'), Icon: Rows3 };
    case 'manual':
      return { label: t('pagesSourceManual'), Icon: Link2 };
    case 'description':
      return { label: t('pagesSourceDescription'), Icon: Tag };
    case 'explanation':
      return { label: t('pagesSourceExplanation'), Icon: Tag };
    /* v8 ignore next 4 -- the compile-time exhaustiveness arm; the union is closed */
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

/** The row's place as breadcrumb segments, root-first, ending at the PARENT. */
function placeSegments(
  place: WorkItemPageLinkPlaceDto,
  rootLabel: string,
  untitled: string,
): BreadcrumbSegment[] {
  return [
    { kind: 'root', id: 'root', label: rootLabel, href: '' },
    ...place.folderPath.map(
      (name, i): BreadcrumbSegment => ({ kind: 'folder', id: String(i), label: name, href: '' }),
    ),
    ...(place.parentPageTitle === null
      ? []
      : [
          {
            kind: 'page',
            id: 'parent',
            label: place.parentPageTitle || untitled,
            href: '',
          } satisfies BreadcrumbSegment,
        ]),
  ];
}

function Place({ place }: { place: WorkItemPageLinkPlaceDto }) {
  const t = useTranslations('pages');
  const segments = placeSegments(place, t('index.title'), t('untitled'));
  const { head, hidden, tail } = foldSegments(segments);
  const separator = (
    <li aria-hidden className="flex items-center">
      <ChevronRight className="h-3 w-3 shrink-0 text-(--el-icon-muted)" />
    </li>
  );
  const segment = (s: BreadcrumbSegment, index: number) => (
    <Fragment key={`${s.kind}:${s.id}`}>
      {index > 0 ? separator : null}
      <li className="inline-flex max-w-[180px] min-w-0 items-center gap-1">
        {s.kind === 'folder' ? (
          <>
            <Folder className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">{t('tree.breadcrumb.folder')}</span>
          </>
        ) : null}
        <span className="truncate">{s.label}</span>
      </li>
    </Fragment>
  );
  return (
    <ol
      aria-label={t('tree.breadcrumb.label')}
      title={hidden.length > 0 ? segments.map((s) => s.label).join(' › ') : undefined}
      className="m-0 mt-0.5 flex min-w-0 list-none items-center gap-1 p-0 text-xs text-(--el-text-secondary)"
    >
      {head.map(segment)}
      {hidden.length > 0 ? (
        <>
          {separator}
          <li className="inline-flex items-center">…</li>
        </>
      ) : null}
      {tail.map((s) => segment(s, 1))}
    </ol>
  );
}

function PageRow({ row }: { row: WorkItemPageLinkRowDto }) {
  const t = useTranslations('issueViews');
  const tPages = useTranslations('pages');
  const format = useFormatter();
  const updated = new Date(row.updatedAt);
  const sources = SOURCE_ORDER.filter((source) => row.sources.includes(source));
  return (
    <Link
      href={`/pages/${encodeURIComponent(row.pageId)}`}
      className="group flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <NotebookText
        className="mt-0.5 h-4 w-4 shrink-0 self-start text-(--el-icon-muted)"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'truncate text-sm group-hover:underline',
            row.title ? 'text-(--el-text)' : 'text-(--el-text-secondary) italic',
          )}
        >
          {row.title || tPages('untitled')}
        </span>
        <Place place={row.place} />
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {sources.map((source) => {
          const { label, Icon } = sourceChip(source, t);
          return (
            <Pill key={source} tone="neutral">
              <Icon className="h-3 w-3 shrink-0" aria-hidden />
              {label}
            </Pill>
          );
        })}
        <time
          dateTime={row.updatedAt}
          title={format.dateTime(updated, { dateStyle: 'medium', timeStyle: 'short' })}
          className="min-w-[5.5rem] text-right text-xs whitespace-nowrap text-(--el-text-secondary)"
        >
          {format.relativeTime(updated)}
        </time>
      </span>
    </Link>
  );
}

/** The initial read's pulse — `SectionCardSkeleton`'s two-bar body. */
function FirstReadSkeleton() {
  return (
    <div
      aria-busy="true"
      data-testid="pages-section-loading"
      className="flex animate-pulse flex-col gap-2"
    >
      <span className="block h-3 w-2/3 rounded-(--radius-control) bg-(--el-muted)" />
      <span className="block h-3 w-1/2 rounded-(--radius-control) bg-(--el-muted)" />
    </div>
  );
}

/** Show more pages' pending rows — row-shaped, after the rows already shown. */
function MoreSkeleton() {
  return (
    <div
      aria-busy="true"
      data-testid="pages-section-loading-more"
      className="mt-3 flex animate-pulse flex-col gap-3.5"
    >
      {[
        ['w-[55%]', 'w-[35%]'],
        ['w-[66%]', 'w-1/2'],
      ].map(([first, second]) => (
        <div key={first} className="flex items-center gap-3">
          <span className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className={cn('block h-2.5 rounded-(--radius-control) bg-(--el-muted)', first)} />
            <span
              className={cn('block h-2.5 rounded-(--radius-control) bg-(--el-muted)', second)}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

type FirstRead = 'loading' | 'failed' | 'loaded';

export function PagesSection({ workItemId, identifier, headerAction }: PagesSectionProps) {
  const t = useTranslations('issueViews');
  const tCommon = useTranslations('common');

  const [rows, setRows] = useState<WorkItemPageLinkRowDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [firstRead, setFirstRead] = useState<FirstRead>('loading');
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The cursor whose page failed to load, so Try again re-reads exactly it.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  // Sequence guard: a response that is no longer the latest request's never
  // clobbers newer state (CLAUDE.md § the app side).
  const seq = useRef(0);

  const readFirst = useCallback(() => {
    const mine = ++seq.current;
    return fetchWorkItemPages(workItemId, null)
      .then((page: WorkItemPagesDto) => {
        if (mine !== seq.current) return;
        setRows(page.rows);
        setNextCursor(page.nextCursor);
        setFirstRead('loaded');
      })
      .catch(() => {
        if (mine === seq.current) setFirstRead('failed');
      });
  }, [workItemId]);

  useEffect(() => {
    void readFirst();
  }, [readFirst]);

  // `/items/<KEY>#pages`: the section streams in after the browser has looked for
  // the fragment, so it lands itself once, when it mounts.
  useEffect(() => {
    if (window.location.hash !== `#${PAGES_SECTION_ID}`) return;
    const el = document.getElementById(PAGES_SECTION_ID);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, []);

  function retryFirstRead() {
    setRetrying(true);
    void readFirst().finally(() => setRetrying(false));
  }

  function loadMore(cursor: string) {
    const mine = ++seq.current;
    setLoadingMore(true);
    setFailedCursor(null);
    void fetchWorkItemPages(workItemId, cursor)
      .then((page) => {
        if (mine !== seq.current) return;
        setRows((current) => {
          const seen = new Set(current.map((row) => row.pageId));
          return [...current, ...page.rows.filter((row) => !seen.has(row.pageId))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (mine === seq.current) setFailedCursor(cursor);
      })
      .finally(() => {
        if (mine === seq.current) setLoadingMore(false);
      });
  }

  let body: ReactNode;
  if (firstRead === 'loading') {
    body = <FirstReadSkeleton />;
  } else if (firstRead === 'failed') {
    // Panel 5: a flush line, NOT the `ErrorState` card (a card in the section
    // card). The section stays — hiding it would claim no page links here.
    body = (
      <div role="status" className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-(--el-text-secondary)">{t('pagesError')}</span>
        <Button variant="secondary" size="sm" loading={retrying} onClick={retryFirstRead}>
          {tCommon('retry')}
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    // Panel 3: the section STAYS when empty, unlike Plans — "no" is an answer.
    body = <p className="m-0 text-sm text-(--el-text-secondary) italic">{t('pagesEmpty')}</p>;
  } else {
    body = (
      <>
        <ul
          aria-label={t('pagesListAria', { key: identifier })}
          className="-mx-(--spacing-control-x) my-0 flex list-none flex-col p-0"
        >
          {rows.map((row, index) => (
            <li
              key={row.pageId}
              className={cn(
                'flex items-center gap-1 rounded-(--radius-control) pr-1 hover:bg-(--el-surface)',
                index > 0 && 'border-t border-(--el-border-soft)',
              )}
            >
              <PageRow row={row} />
            </li>
          ))}
        </ul>
        {loadingMore ? <MoreSkeleton /> : null}
        {failedCursor !== null ? (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-3"
          >
            <span className="text-[13px] text-(--el-text-secondary)">
              {t('pagesLoadMoreError')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => loadMore(failedCursor)}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : nextCursor ? (
          <button
            type="button"
            onClick={() => loadMore(nextCursor)}
            disabled={loadingMore}
            className="mt-3 h-(--height-control) w-full rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('pagesShowMore')}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <ContentSectionCard
      id={PAGES_SECTION_ID}
      title={t('pagesTitle')}
      subtitle={t('pagesGloss')}
      headerRight={headerAction}
    >
      {body}
    </ContentSectionCard>
  );
}
