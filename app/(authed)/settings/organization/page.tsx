import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { isCloudBilling } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { billingService } from '@/lib/services/billingService';
import { OrgGeneralCard } from './_components/OrgGeneralCard';
import { AcceptanceVideoCard } from './_components/AcceptanceVideoCard';
import { BillingCard } from './_components/BillingCard';
import { WorkspaceConfigCard } from './_components/WorkspaceConfigCard';
import { DangerZoneCard } from './_components/DangerZoneCard';

// Organization settings (Story 6.10.5, design/org-admin panel 2) — the
// org-scoped Settings home. Org owner/admin only: a plain org member sees the
// forbidden panel (5d), not the controls. The active org is resolved from the
// org cookie (the shell switcher sets it). NO billing/credit surface here —
// that is 7.12.5 / Epic 8 (only a passive "Coming soon" placeholder).

export default async function OrganizationSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('orgAdmin');

  const orgCookie = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(session.user.id, orgCookie);

  if (!current) {
    return (
      <div className="mx-auto max-w-[45rem]">
        <EmptyState
          title={t('states.noActiveOrgTitle')}
          description={t('states.noActiveOrgDescription')}
        />
      </div>
    );
  }

  const org = current.organization;
  const isAdmin =
    current.role === ORGANIZATION_ROLE.owner || current.role === ORGANIZATION_ROLE.admin;

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-[45rem]">
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={t('states.forbiddenTitle')}
          description={t('states.forbiddenDescription', { org: org.name })}
          action={
            <Link
              href="/dashboard"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('states.backToWorkspace')}
            </Link>
          }
        />
      </div>
    );
  }

  // Counts for the general-card footer + the fold-in card (membership-scoped to
  // the active org). The workspace fold-in only shows at exactly one workspace.
  const orgWorkspaces = (await workspacesService.listUserWorkspaces(session.user.id)).filter(
    (w) => w.organizationId === org.id,
  );
  const { total: memberCount } = await organizationsService.listMembers({
    organizationId: org.id,
    actorUserId: session.user.id,
    limit: 1,
  });

  // Acceptance-video card (MOTIR-1635): the toggle is only effective with a paid
  // AI plan (cloud); off-cloud the feature is ungated, so treat it as planned.
  const hasAcceptancePlan = isCloudBilling()
    ? (await billingService.getAiAccess({ actorUserId: session.user.id, organizationId: org.id }))
        .hasPaidAiPlan
    : true;

  return (
    <div className="mx-auto flex max-w-[45rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('settings.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('settings.subtitle', { org: org.name })}
        </p>
      </header>

      <OrgGeneralCard
        orgId={org.id}
        initialName={org.name}
        slug={org.slug}
        role={current.role}
        workspaceCount={orgWorkspaces.length}
        memberCount={memberCount}
      />

      {/* The live billing "door" (8.1.7, design/billing panel 1) replaces the
          passive placeholder — cloud-only (ADR §6): off-cloud there is no
          billing surface at all, so the card simply doesn't render. */}
      {isCloudBilling() ? <BillingCard /> : null}

      <AcceptanceVideoCard
        orgId={org.id}
        initialEnabled={org.acceptanceVideoEnabled}
        hasPlan={hasAcceptancePlan}
        canManage={isAdmin}
      />

      {orgWorkspaces.length <= 1 ? (
        <WorkspaceConfigCard workspaceCount={orgWorkspaces.length} />
      ) : null}

      <DangerZoneCard />
    </div>
  );
}
