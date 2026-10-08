import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { getEnterpriseRequestAction } from '../actions';
import { EnterpriseRequestDetailView } from '../_components/EnterpriseRequestDetailView';
import { EnterpriseRequestStateCard } from '../_components/EnterpriseRequestStateCard';
import { EnterpriseRequestsUnavailable } from '../_components/EnterpriseRequestsUnavailable';

/**
 * One ENTERPRISE REQUEST — design `platform-admin/design-notes.md` §
 * Enterprise requests Panels 4–8, card MOTIR-7609, story MOTIR-7602.
 *
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no `<Suspense>` (and no `loading.tsx`) above it: an id
 * the store does not have is the app's 404 with a real 404 status (CLAUDE.md's
 * boundary rule). Opening it is one audited `estate.read`, which the service
 * writes.
 *
 * Every staff role reads. The state card shows the moves the service returned
 * for this viewer — none for `support`, none on a closed request — and
 * `canMove` only chooses which line stands in for them. The service re-gates
 * every move at `operator`; the missing buttons are presentation.
 */

export const metadata: Metadata = { title: 'Enterprise request' };

export const dynamic = 'force-dynamic';

export default async function AdminEnterpriseRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const { id } = await params;

  const result = await getEnterpriseRequestAction(id);
  if (!result.ok) {
    if (result.code === 'NOT_FOUND' || result.code === 'NOT_PERMITTED') notFound();
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <EnterpriseRequestsUnavailable />
      </div>
    );
  }

  const { detail } = result;
  const { request } = detail;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <EnterpriseRequestDetailView
        detail={detail}
        stateCard={
          <EnterpriseRequestStateCard
            requestId={request.id}
            organizationId={request.organizationId}
            organizationName={request.organizationName}
            status={request.status}
            moves={detail.moves}
            closedAt={request.closedAt}
            canMove={platformRoleAtLeast(principal.role, 'operator')}
          />
        }
      />
    </div>
  );
}
