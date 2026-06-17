import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { EmptyState } from '@/components/ui/EmptyState';
import { OrgUsageClient } from './_components/OrgUsageClient';

// The ORG-LEVEL token-cost dashboard (Story 7.2, subtask 7.2.11; design
// ai-usage). The org admin's home for token cost — balance, tier, spend, the
// org → workspace → project drill-down, the per-model breakdown and a paginated
// run log. Unlike the admin-only settings/members page, ANY org member may open
// this: an admin sees the full org-wide view; a non-admin member sees their own
// project slice, read-only (the 6.10.4 gate, decided server-side in
// aiUsageService). The figures live in motir-ai and are fetched client-side over
// the 7.1 boundary, so this server page only gates + resolves the active org.

export default async function OrganizationUsagePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('aiUsage');
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

  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-(--el-text-muted) font-sans text-xs">
          {t('breadcrumb', { org: org.name })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="text-(--el-text-muted) max-w-prose font-sans text-sm">
          {t('subtitle', { org: org.name })}
        </p>
      </header>

      <OrgUsageClient orgId={org.id} orgName={org.name} />
    </div>
  );
}
