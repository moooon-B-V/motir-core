import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Eye } from 'lucide-react';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { listEnterpriseRequestsAction } from './actions';
import { EnterpriseRequestsCard, NoRequestsYet } from './_components/EnterpriseRequestsCard';
import { EnterpriseRequestsSkeleton } from './_components/EnterpriseRequestsSkeleton';
import { EnterpriseRequestsUnavailable } from './_components/EnterpriseRequestsUnavailable';
import {
  readRequestListView,
  requestListHref,
  type RequestListSearchParams,
  type RequestListView,
} from './_components/requestListQuery';

/**
 * The console's ENTERPRISE REQUESTS page — design
 * `platform-admin/design-notes.md` § Enterprise requests (MOTIR-7604) Panels
 * 1–3, card MOTIR-7609, story MOTIR-7602.
 *
 * What organisations sent from the Enterprise card's Contact sales, across
 * every organisation, newest first, 50 a page by cursor, narrowed by state
 * (default **Open**). Every staff role reads; a non-staff request gets the
 * app's 404 from this page's gate as from the layout's (`pageGate.ts`,
 * MOTIR-7613). Reading the list is one audited `estate.read`, which the service
 * writes.
 *
 * The read goes through the console's server action, whose discriminated
 * result is the page's state: a page of rows, or `FAILED` / `INVALID_QUERY`
 * (a cursor the service did not issue) as the error card with Retry.
 */

export const metadata: Metadata = { title: 'Enterprise requests' };

/** Never cached — a request moved a minute ago must show its new state on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminEnterpriseRequestsPage({
  searchParams,
}: {
  searchParams: Promise<RequestListSearchParams>;
}) {
  await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.enterpriseRequests');
  const view = readRequestListView(await searchParams);

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Eye aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>
            <strong className="font-semibold text-(--el-text-strong)">{t('auditLead')}</strong>{' '}
            {t('auditBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (CLAUDE.md's
          boundary rule); the header above paints at once (Panel 3a). */}
      <Suspense
        key={requestListHref(view)}
        fallback={<EnterpriseRequestsSkeleton filter={view.filter} />}
      >
        <RequestsSection view={view} />
      </Suspense>
    </div>
  );
}

async function RequestsSection({ view }: { view: RequestListView }) {
  const result = await listEnterpriseRequestsAction(view.filter, view.cursors.at(-1) ?? null);
  if (!result.ok) return <EnterpriseRequestsUnavailable />;
  // Nothing ever sent (Panel 3b) — no filter to clear, so no card around it.
  if (result.page.counts.all === 0) return <NoRequestsYet />;
  return <EnterpriseRequestsCard page={result.page} view={view} />;
}
