import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { isCloudBilling } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { BillingClient } from './_components/BillingClient';

// The org billing & plans surface (Story 8.1.7, design/billing panels 1–6, 8) —
// the org owner's home for money: the two billed lines (Motir seats + Motir AI),
// the lifecycle states, the role gate, the AI-plan storefront and the seat-plan
// screen. CLOUD-ONLY (ADR §6): off-cloud the whole surface does not exist, so the
// route 404s behind `isCloudBilling()`, matching the hidden org-menu row + the
// missing settings card. The figures live in motir-ai and are fetched client-side
// over the 8.1.6 boundary, so this server page only gates + resolves the active
// org and its seat count; the VIEW/MUTATE permission split (owner/admin vs owner)
// is decided server-side in billingService and rendered from the response.
export default async function OrganizationBillingPage() {
  // Off-cloud (self-hosted GPL build): the commercial surface does not exist.
  if (!isCloudBilling()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('billing');
  const tOrg = await getTranslations('orgAdmin');

  const orgCookie = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(session.user.id, orgCookie);

  if (!current) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState
          title={tOrg('states.noActiveOrgTitle')}
          description={tOrg('states.noActiveOrgDescription')}
        />
      </div>
    );
  }

  const org = current.organization;

  // The seat count (one seat per member, ADR §3) for the seat preview + the
  // panel-6 seat calc — resolved here the same way the org settings page does.
  const { total: memberCount } = await organizationsService.listMembers({
    organizationId: org.id,
    actorUserId: session.user.id,
    limit: 1,
  });

  return (
    <div className="mx-auto max-w-[64rem]">
      {/* The header lives inside BillingClient so it swaps with the active
          screen (home / Motir AI / Motir seats), each with its own breadcrumb. */}
      <span className="sr-only">{t('title')}</span>
      <BillingClient orgId={org.id} orgName={org.name} memberCount={memberCount} />
    </div>
  );
}
