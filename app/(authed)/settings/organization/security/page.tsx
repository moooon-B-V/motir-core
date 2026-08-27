import { Suspense } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { RequireTwoFactorCard } from '../_components/RequireTwoFactorCard';
import { setOrganizationRequireTwoFactorAction } from './actions';

// Organization Security (Story MOTIR-1215 · Subtask MOTIR-3646), built to
// `design/org-admin/security-policy.mock.html` panels 3, 4, 8 and 9.
//
// ⚠️ A WHOLE-PANE REFUSAL, and that is a DIFFERENT rule from its parent's.
// `settings/organization/page.tsx` gates PER SECTION (MOTIR-3519) because that
// page HOSTS workspace-scoped sections below the tier-reveal threshold, and a
// whole-page refusal there would close the only remaining route to them for a
// plain org member. This pane hosts nothing but org-scoped controls, so it
// refuses the way its siblings `members/` and `usage/` do — one `EmptyState`,
// no header above it.
//
// The design's own Planning flag #2 raised exactly this as a decision to take
// deliberately rather than by accident: its panel 8 draws the refusal INSIDE a
// rendered pane, matching the parent page. MOTIR-3646 settles it the other way,
// on the sibling convention the card cites. Recorded here because the asset and
// the route now differ on purpose, and the next reader should not "fix" one to
// match the other.
//
// ⚠️ NO `loading.tsx`. The frame is an in-page `<Suspense>` placed AFTER the
// gate, so the status is settled before anything flushes (`CLAUDE.md`'s
// boundary rule; `tests/navigation/loading-boundary-guard.test.ts` enforces it).

export default async function OrganizationSecurityPage() {
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

  // The header is painted ABOVE the boundary — its title is a constant and its
  // subtitle interpolates a name the gate has already resolved — so the frame
  // beneath it stands in for the CARD and nothing else (`SettingsPaneFrame`'s
  // own contract).
  return (
    <div className="mx-auto flex max-w-[45rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('security.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('security.subtitleOrg', { org: org.name })}
        </p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <SecurityPaneBody
          organizationId={org.id}
          orgName={org.name}
          actorUserId={session.user.id}
        />
      </Suspense>
    </div>
  );
}

/** The pane's one read, below the boundary. */
async function SecurityPaneBody({
  organizationId,
  orgName,
  actorUserId,
}: {
  organizationId: string;
  orgName: string;
  actorUserId: string;
}) {
  const t = await getTranslations('orgAdmin');
  const policy = await twoFactorPolicyService.getOrganizationPolicy(organizationId, actorUserId);

  return (
    <RequireTwoFactorCard
      requiresTwoFactor={policy.requiresTwoFactor}
      // ⚠️ ALWAYS null at this tier: nothing sits above an organization, so the
      // org control is never locked. The prop exists for MOTIR-3647, which
      // mounts this same component one tier down.
      lockedBy={null}
      description={t('security.cardBodyOrg')}
      stateOnLabel={t('security.stateOnOrg', { org: orgName })}
      canManage
      tierName={orgName}
      onSave={setOrganizationRequireTwoFactorAction}
    />
  );
}
