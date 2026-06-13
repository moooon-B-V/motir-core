import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { OrgMembersClient, ORG_ROSTER_PAGE_SIZE } from './_components/OrgMembersClient';

// Cross-workspace member management (Story 6.10.5, design/org-admin panel 3) —
// the roster of everyone across the org's workspaces, paginated (the at-scale
// rule, finding #57). Org owner/admin only; a plain member sees the forbidden
// panel (5d). The first page is fetched server-side for an SSR'd roster; the
// client component owns Prev/Next paging + invite + role-change + remove.

export default async function OrganizationMembersPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('orgAdmin');

  const orgCookie = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(session.user.id, orgCookie);

  if (!current) {
    return (
      <div className="mx-auto max-w-[48rem]">
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
      <div className="mx-auto max-w-[48rem]">
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

  const initialPage = await organizationsService.listMembers({
    organizationId: org.id,
    actorUserId: session.user.id,
    limit: ORG_ROSTER_PAGE_SIZE,
  });

  return (
    <div className="mx-auto flex max-w-[48rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('members.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('members.subtitle', { org: org.name })}
        </p>
      </header>

      <OrgMembersClient
        orgId={org.id}
        orgName={org.name}
        currentUserId={session.user.id}
        initialPage={initialPage}
      />
    </div>
  );
}
