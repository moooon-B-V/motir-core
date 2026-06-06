'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowRight, Clock, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import { Avatar, AssigneeValue, PriorityValue, StatusValue } from './issueCellPrimitives';
import { QuickViewCloseButton } from './QuickViewCloseButton';

// The presentational quick-view PANEL (Subtask 2.5.19) — the modal body the
// IssueQuickView frame wraps, per design/work-items/quick-view.mock.html. Pure
// view: it takes already-shaped, serializable data (resolved by the async
// IssueQuickViewContent) and renders one of three states — `loading` (the
// Suspense fallback while the item fetches, panel 3), `notfound` (a stale /
// cross-workspace / deleted key, panel 4), or `ready` (the populated peek,
// panel 2). A large two-column body: scrollable main (title + FULL description)
// + a condensed core-fields rail. Read-only — editing lives on the full page.
//
// Composes ONLY shipped primitives — Modal (the frame), IssueTypeIcon (type
// hue), Pill via StatusValue / PriorityValue, the row Avatar, MarkdownView — so
// no new visual primitive is invented (AC). Colour via --el-* only; shape via
// the element-semantic tokens.

/** The serializable payload the peek renders (a condensed slice of the detail read). */
export interface QuickViewData {
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  statusLabel: string;
  statusCategory: StatusCategoryDto | null;
  descriptionMd: string | null;
  assigneeName: string | null;
  reporterName: string;
  priority: WorkItemPriorityDto;
  dueLabel: string | null;
  estimateLabel: string | null;
  parent: { identifier: string; title: string; kind: WorkItemKindDto } | null;
  /**
   * The ready/blocked readiness signal (Subtask 2.5.21), shaped for the shipped
   * ReadinessBadge. `null` when the item has NO `is_blocked_by` in-edge — mirror
   * the detail-page rule: nothing blocks it, so there's no readiness signal to
   * give. Otherwise `ready` is the service verdict and `blockers` names the OPEN
   * (non-terminal) blockers; the panel maps each to a `?peek=` swap-peek href (so
   * a blocker link swaps the peeked item in-list, never leaving `/issues` — the
   * 2.5.20 design's justified deviation from the detail-page badge, which links
   * to `/issues/[key]`). The panel additionally suppresses the banner once the
   * item leaves the `todo` category (see `statusCategory`): "can I start this?"
   * is moot for an item already in progress or done.
   */
  readiness: { ready: boolean; blockers: string[] } | null;
}

type IssueQuickViewPanelProps =
  | { state: 'loading'; peekKey: string }
  | { state: 'notfound'; peekKey: string }
  | { state: 'ready'; data: QuickViewData };

/** "Open full page →" — a Next Link styled as the primary Button (size sm). */
function OpenFullPageLink({ identifier }: { identifier: string }) {
  const t = useTranslations('issueViews');
  return (
    <Link
      href={`/issues/${identifier}`}
      data-testid="quick-view-open-full"
      className="inline-flex h-(--height-btn-sm) shrink-0 items-center justify-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-3 font-sans text-xs font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {t('openFullPage')}
      <ArrowRight className="h-[15px] w-[15px]" aria-hidden />
    </Link>
  );
}

/** A rail field — uppercase caption over its value. */
function RailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-sm text-(--el-text-secondary)">
        {children}
      </dd>
    </div>
  );
}

/** A pulsing skeleton bar (the loading state's placeholders). */
function Sk({ className }: { className?: string }) {
  return (
    <span
      className={`block animate-pulse rounded-(--radius-control) bg-(--el-muted) ${className ?? ''}`}
    />
  );
}

export function IssueQuickViewPanel(props: IssueQuickViewPanelProps) {
  const t = useTranslations('issueViews');
  // A named readiness blocker SWAPS the peek (push `?peek=<blockerKey>`, staying
  // in-list) rather than navigating to the full page — the 2.5.20 design. Build
  // the href the same way QuickViewTrigger opens a peek: preserve every other
  // param (view/sort/filter/page), just swap `peek`.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const buildPeekHref = (identifier: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('peek', identifier);
    return `${pathname}?${params.toString()}`;
  };

  // ── NOT FOUND / NO ACCESS (panel 4) ──────────────────────────────────────
  if (props.state === 'notfound') {
    return (
      <>
        <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
          <span className="flex-1" />
          <QuickViewCloseButton variant="icon" />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="mb-1.5 inline-flex h-14 w-14 items-center justify-center rounded-full bg-(--el-muted) text-(--el-text-muted)">
            <SearchX className="h-7 w-7" aria-hidden />
          </span>
          <h2 className="font-serif text-lg font-semibold text-(--el-text)">
            {t('quickViewUnavailableTitle')}
          </h2>
          <p className="max-w-[24rem] text-sm leading-relaxed text-(--el-text-secondary)">
            {t('quickViewUnavailableDescription', { key: props.peekKey })}
          </p>
          <div className="mt-3">
            <QuickViewCloseButton variant="button" />
          </div>
        </div>
      </>
    );
  }

  // ── LOADING (panel 3) — fields fetch while the modal is already open ──────
  if (props.state === 'loading') {
    return (
      <>
        <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
          <Sk className="h-[18px] w-[18px] rounded-(--radius-control)" />
          <Sk className="h-3.5 w-16" />
          <Sk className="h-5 w-20 rounded-(--radius-badge)" />
          <span className="flex-1" />
          <OpenFullPageLink identifier={props.peekKey} />
          <QuickViewCloseButton variant="icon" />
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7" role="status" aria-live="polite">
            <span className="sr-only">{t('quickViewLoadingAria')}</span>
            <Sk className="mb-6 h-7 w-2/3" />
            <Sk className="mb-3 h-2.5 w-24" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="mb-2.5 h-3.5 w-[97%]" />
            <Sk className="mb-2.5 h-3.5 w-[92%]" />
            <Sk className="mb-6 h-3.5 w-3/5" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="h-3.5 w-4/5" />
          </div>
          <dl className="flex min-w-0 flex-col gap-5 border-l border-(--el-border) bg-(--el-surface-soft) px-5 py-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Sk className="h-2.5 w-14" />
                <Sk className="h-5 w-28 rounded-(--radius-badge)" />
              </div>
            ))}
          </dl>
        </div>
      </>
    );
  }

  // ── READY (panel 2) — the populated peek ──────────────────────────────────
  const { data } = props;
  return (
    <>
      <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
        <IssueTypeIcon type={data.kind} className="h-[18px] w-[18px] shrink-0" />
        <Link
          href={`/issues/${data.identifier}`}
          className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[13px] font-medium text-(--el-link) hover:underline focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {data.identifier}
        </Link>
        <StatusValue category={data.statusCategory} label={data.statusLabel} />
        <span className="flex-1" />
        <OpenFullPageLink identifier={data.identifier} />
        <QuickViewCloseButton variant="icon" />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main — title + the FULL description (scrollable). */}
        <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7">
          <h2 className="font-serif text-[27px] leading-tight font-semibold text-(--el-text)">
            {data.title}
          </h2>
          {/* Readiness banner (2.5.21) — the shipped ReadinessBadge, top of the
              main column under the title, per quick-view.mock.html (2.5.20). Shown
              only for a TODO-category item that has blockers: no banner without
              blockers, and none once the item is in-progress / done ("can I start
              this?" is moot past todo). Named blockers swap the peek. */}
          {data.readiness && data.statusCategory === 'todo' ? (
            <ReadinessBadge
              ready={data.readiness.ready}
              blockers={data.readiness.blockers.map((identifier) => ({
                identifier,
                href: buildPeekHref(identifier),
              }))}
              className="mt-4"
            />
          ) : null}
          <span className="mt-6 mb-2 block text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {t('description')}
          </span>
          {data.descriptionMd ? (
            <MarkdownView value={data.descriptionMd} aria-label={t('issueDescriptionAria')} />
          ) : (
            <p className="text-sm text-(--el-text-secondary) italic">{t('noDescription')}</p>
          )}
          <p className="mt-6 flex items-center gap-1.5 border-t border-(--el-border-soft) pt-4 text-[13px] text-(--el-text-muted)">
            {t.rich('quickViewMore', {
              link: (chunks) => (
                <Link
                  href={`/issues/${data.identifier}`}
                  className="font-medium text-(--el-link) hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>

        {/* Rail — the detail page's core fields, condensed. */}
        <dl className="flex min-w-0 flex-col gap-4 overflow-y-auto border-l border-(--el-border) bg-(--el-surface-soft) px-5 py-6">
          <RailField label={t('status')}>
            <StatusValue category={data.statusCategory} label={data.statusLabel} />
          </RailField>
          <RailField label={t('assignee')}>
            <AssigneeValue name={data.assigneeName} />
          </RailField>
          <RailField label={t('reporter')}>
            <Avatar name={data.reporterName} />
            <span className="truncate">{data.reporterName}</span>
          </RailField>
          <RailField label={t('priority')}>
            <PriorityValue priority={data.priority} />
          </RailField>
          <RailField label={t('dueDate')}>
            {data.dueLabel ? (
              <span className="truncate">{data.dueLabel}</span>
            ) : (
              <span className="text-(--el-text-muted)">{t('noDueDate')}</span>
            )}
          </RailField>
          <RailField label={t('estimate')}>
            {data.estimateLabel ? (
              <>
                <Clock className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                <span className="truncate">{data.estimateLabel}</span>
              </>
            ) : (
              <span className="text-(--el-text-muted)">{t('noEstimate')}</span>
            )}
          </RailField>
          <RailField label={t('parent')}>
            {data.parent ? (
              <Link
                href={`/issues/${data.parent.identifier}`}
                className="flex min-w-0 items-center gap-1.5 text-(--el-link) hover:underline"
              >
                <IssueTypeIcon type={data.parent.kind} className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-mono text-xs">{data.parent.identifier}</span>
                <span className="truncate text-(--el-text-secondary)">{data.parent.title}</span>
              </Link>
            ) : (
              <span className="text-(--el-text-muted)">{t('none')}</span>
            )}
          </RailField>
        </dl>
      </div>
    </>
  );
}
