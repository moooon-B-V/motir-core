import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Filter, Inbox, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type {
  EnterpriseRequestFilter,
  PlatformEnterpriseRequestDTO,
  PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';
import { EnterpriseRequestStatusPill, RequestNeeds, tierName } from './EnterpriseRequestBits';
import { RequestStateFilter } from './RequestStateFilter';
import { requestDetailHref, requestListHref, type RequestListView } from './requestListQuery';

/**
 * The REQUESTS card — design `platform-admin/design-notes.md` § Enterprise
 * requests Panels 1–3 and 9. Its title with the count line, the state filter,
 * then the table (one stacked row per request below `md`), then the foot: _Newest
 * first · 50 a page_ and the cursor pager (_1–50 of 63_, Newer / Older).
 *
 * No hooks beyond next-intl's, so the server page renders it and a component
 * test renders it from a DTO. The two empty states differ by design: nothing
 * EVER sent is the never-any state with no filter (Panel 3b, `NoRequestsYet`);
 * a filter with nothing in it is the filter-shaped one with a way back
 * (Panel 2 right) and keeps the card and its filter.
 */

/** The card's header — title, count line, filter. The skeleton paints the same frame. */
export function RequestsCardFrame({
  filter,
  countLine,
  counts,
  children,
}: {
  filter: EnterpriseRequestFilter;
  countLine: ReactNode;
  counts?: Record<EnterpriseRequestFilter, number>;
  children: ReactNode;
}) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  return (
    <Card
      data-testid="enterprise-requests-card"
      header={
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
          >
            <Inbox className="h-4 w-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('cardTitle')}</h2>
            <p
              data-testid="enterprise-requests-count"
              className="font-sans text-xs text-(--el-text-secondary)"
            >
              {countLine}
            </p>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <RequestStateFilter value={filter} counts={counts} />
        {children}
      </div>
    </Card>
  );
}

export function EnterpriseRequestsCard({
  page,
  view,
}: {
  page: PlatformEnterpriseRequestPageDTO;
  view: RequestListView;
}) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const bold = (chunks: ReactNode) => (
    <b className="font-semibold text-(--el-text-strong)">{chunks}</b>
  );
  const filter = page.filter;
  const countLine =
    filter === 'open'
      ? t.rich('count.open', { count: page.total, b: bold })
      : filter === 'all'
        ? t.rich('count.all', { count: page.total, b: bold })
        : t.rich('count.state', { count: page.total, state: t(`stateWord.${filter}`), b: bold });

  let body: ReactNode;
  if (page.requests.length > 0) {
    body = (
      <>
        <RequestsTable requests={page.requests} />
        <RequestsPager page={page} view={view} />
      </>
    );
  } else {
    // The filter-shaped empty state (Panel 2, right): never the never-any one,
    // because something was sent — just nothing in this state.
    const word = t(`stateWord.${filter}`);
    body = (
      <EmptyState
        data-testid="enterprise-requests-no-match"
        icon={<Filter />}
        title={t('emptyFilter.title', { state: word })}
        description={t('emptyFilter.body', { state: word })}
        action={
          <Link
            href={requestListHref(filter === 'open' ? { filter: 'all' } : {})}
            className="inline-flex h-(--height-btn-md) items-center rounded-(--radius-btn) border border-(--el-button-border) px-(--spacing-btn-x) font-sans text-sm text-(--el-text) hover:bg-(--el-surface)"
          >
            {filter === 'open' ? t('emptyFilter.actionAll') : t('emptyFilter.action')}
          </Link>
        }
      />
    );
  }

  return (
    <RequestsCardFrame filter={filter} countLine={countLine} counts={page.counts}>
      {body}
    </RequestsCardFrame>
  );
}

/** Panel 3b — no request has ever been sent: no filter, nothing to clear. */
export function NoRequestsYet() {
  const t = useTranslations('platformAdmin.enterpriseRequests.empty');
  return (
    <EmptyState
      data-testid="enterprise-requests-empty"
      icon={<Inbox />}
      title={t('title')}
      description={t('body')}
    />
  );
}

function RequestsTable({ requests }: { requests: PlatformEnterpriseRequestDTO[] }) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const ago = (iso: string) => format.relativeTime(new Date(iso));

  const orgLink = (r: PlatformEnterpriseRequestDTO) => (
    <Link
      href={requestDetailHref(r.id)}
      className="font-medium text-(--el-text) after:absolute after:inset-0 after:content-['']"
    >
      {r.organizationName}
    </Link>
  );
  const tierLine = (r: PlatformEnterpriseRequestDTO) =>
    r.tierKeyAtRequest ? (
      <span className="text-xs text-(--el-text-secondary)">
        {t('tierWhenSent', { tier: tierName(r.tierKeyAtRequest) })}
      </span>
    ) : null;
  const requester = (r: PlatformEnterpriseRequestDTO) =>
    r.requester ? (
      <>
        <span className="text-(--el-text)">{r.requester.name}</span>
        <span className="text-xs text-(--el-text-secondary)">{r.requester.email}</span>
      </>
    ) : (
      <span className="text-xs italic text-(--el-text-secondary)">{t('requesterGone')}</span>
    );

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table
          data-testid="enterprise-requests-table"
          className="w-full border-collapse font-sans text-sm"
        >
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th>{t('col.organisation')}</Th>
              <Th>{t('col.requester')}</Th>
              <Th>{t('col.sent')}</Th>
              <Th>{t('col.needs')}</Th>
              <Th>{t('col.state')}</Th>
              <th aria-hidden className="w-6" />
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr
                key={r.id}
                data-testid={`enterprise-request-row-${r.id}`}
                data-status={r.status}
                className="relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft)"
              >
                <Td>
                  <div className="flex flex-col gap-0.5">
                    {orgLink(r)}
                    {tierLine(r)}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5">{requester(r)}</div>
                </Td>
                <Td className="whitespace-nowrap">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-(--el-text)">{date(r.createdAt)}</span>
                    <span className="text-xs text-(--el-text-secondary)">{ago(r.createdAt)}</span>
                  </div>
                </Td>
                <Td className="max-w-[22rem]">
                  <RequestNeeds request={r} />
                </Td>
                <Td>
                  <EnterpriseRequestStatusPill status={r.status} />
                </Td>
                <Td>
                  <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul data-testid="enterprise-requests-list-narrow" className="flex flex-col md:hidden">
        {requests.map((r) => (
          <li
            key={r.id}
            className="relative flex flex-col gap-1 border-b border-(--el-border-soft) py-3 font-sans text-sm last:border-b-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                {orgLink(r)}
                {tierLine(r)}
              </div>
              <EnterpriseRequestStatusPill status={r.status} />
            </div>
            <span className="text-xs text-(--el-text-secondary)">
              {r.requester ? r.requester.name : t('requesterGone')} · {date(r.createdAt)}
            </span>
            <RequestNeeds request={r} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The foot — _Newest first · 50 a page_ and the keyset pager (the audit log's
 * Newer / Older grammar). The unavailable direction is drawn disabled, not
 * hidden, so the pager keeps its place on a single page.
 */
function RequestsPager({
  page,
  view,
}: {
  page: PlatformEnterpriseRequestPageDTO;
  view: RequestListView;
}) {
  const t = useTranslations('platformAdmin.enterpriseRequests.pager');
  const from = view.cursors.length * page.pageSize + 1;
  const to = from + page.requests.length - 1;
  const newer =
    view.cursors.length > 0
      ? requestListHref({ filter: page.filter, cursors: view.cursors.slice(0, -1) })
      : null;
  const older = page.nextCursor
    ? requestListHref({ filter: page.filter, cursors: [...view.cursors, page.nextCursor] })
    : null;

  const live =
    'inline-flex h-(--height-btn-sm) items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x-sm) font-sans text-sm text-(--el-text) hover:bg-(--el-surface-soft)';
  const off =
    'inline-flex h-(--height-btn-sm) cursor-not-allowed items-center gap-1 rounded-(--radius-btn) border border-(--el-border-soft) px-(--spacing-btn-x-sm) font-sans text-sm text-(--el-text-secondary) opacity-50';

  return (
    <nav
      aria-label={t('label')}
      data-testid="enterprise-requests-pager"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border-soft) pt-3 font-sans text-xs text-(--el-text-secondary)"
    >
      <span className="inline-flex items-center gap-1.5">
        <Info aria-hidden className="h-3.5 w-3.5" />
        {t('note')}
      </span>
      <div className="flex items-center gap-2">
        <span data-testid="enterprise-requests-range">
          {t('range', { from, to, total: page.total })}
        </span>
        {newer ? (
          <Link className={live} href={newer}>
            <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
            {t('newer')}
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
            {t('newer')}
          </span>
        )}
        {older ? (
          <Link className={live} href={older}>
            {t('older')}
            <ChevronRight aria-hidden className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            {t('older')}
            <ChevronRight aria-hidden className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </nav>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
