import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  isWorkspaceTierRevealed,
  preferredOrganizationId,
  scopeWorkspacesToActiveOrg,
} from '@/lib/workspaces/tierDisclosure';
import { getWorkspaceContext } from '@/lib/workspaces';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { isCloudBilling } from '@/lib/billing/availability';
import { hasAiEntitlement } from '@/lib/billing/aiEntitlement';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { billingService } from '@/lib/services/billingService';
import { OrgGeneralCard } from './_components/OrgGeneralCard';
import { AcceptanceVideoCard } from './_components/AcceptanceVideoCard';
import { BillingCard } from './_components/BillingCard';
import { WorkspaceFoldInSection } from './_components/WorkspaceFoldInSection';
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

  // ⚠️ RESOLVE THE ACTIVE ORG THE WAY THE SHELL DOES — the ACTIVE WORKSPACE's org
  // wins, and the cookie is only the fallback for a user with no active workspace
  // (an org-only member). This page used to read the cookie ALONE, so it could
  // disagree with the header about which org is active: a user whose org cookie
  // still pointed at their own org, while their active workspace lived in
  // another, saw the header say `Acme` and this page render a different org's
  // settings.
  //
  // That was survivable while the page was whole-page admin-gated — the users it
  // could happen to were refused anyway. §6d's fold-in is what makes it bite: the
  // page now hosts the ACTIVE workspace's sections, so resolving a different org
  // means hosting the wrong workspace's Name / Members / Danger zone. Both
  // MOTIR-3502 E2E failures were this, not the gate.
  //
  // `preferredOrganizationId` is the same helper the (authed) layout composes, so
  // the two cannot drift again.
  const [ctx, myWorkspaces, cookieStore] = await Promise.all([
    getWorkspaceContext(),
    workspacesService.listUserWorkspaces(session.user.id),
    cookies(),
  ]);
  const activeWorkspace = ctx ? (myWorkspaces.find((w) => w.id === ctx.workspaceId) ?? null) : null;
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(
    session.user.id,
    preferredOrganizationId(activeWorkspace, orgCookie),
  );

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

  // ⚠️ GATED PER SECTION, NOT PER PAGE (MOTIR-3519 · organization-tier.md §6d).
  //
  // This used to `return` panel 5d's forbidden EmptyState for the whole page.
  // That was right while the page carried ORG-scoped cards only — per-page and
  // per-section were then the same rule. §6d's fold-in is what makes them
  // differ: below the workspace-tier reveal threshold this page HOSTS the
  // workspace's Name / Members / Danger-zone sections, and those are gated on
  // WORKSPACE MEMBERSHIP, not on the org role. Keeping the whole-page refusal
  // would have closed the only remaining route to them — including the only
  // route in the product to **Leave workspace** — for a plain org member, who is
  // exactly what a workspace invitee is (§5's upward invariant joins them as
  // `member`).
  //
  // So the refusal moves DOWN to the org-scoped cards, and the rule it applies
  // is the general one §6d states: relocating a surface preserves its GATE. A
  // hidden tier changes what the product NAMES, never what a user may DO.
  //
  // A non-member of the org never reaches here at all — `resolveActiveOrganization`
  // returns null for them and the no-active-org state above answers, which keeps
  // the 404-not-403 posture intact.

  // Counts for the general-card footer + the fold-in (membership-scoped to the
  // active org — the same population the shell's reveal test counts, via the
  // same helper, so this page and the nav can never disagree about the tier).
  const orgWorkspaces = scopeWorkspacesToActiveOrg(myWorkspaces, org.id);
  // §6d: below the reveal threshold `/settings/workspace` does not exist (it
  // 404s), so this page hosts its sections instead. An org-only member with no
  // workspace at all has nothing to fold in.
  const foldInWorkspace = isWorkspaceTierRevealed(orgWorkspaces.length)
    ? null
    : (orgWorkspaces[0] ?? null);
  // MOTIR-3448 — allocation row 13: SERIAL → ONE WAVE, plus the frame.
  //
  // ⚠️ THE MEASUREMENT DIFFERS FROM THE ALLOCATION, and the smaller number is the
  // true one. The asset counts THREE serial reads here — `listUserWorkspaces`,
  // `listMembers`, `getAiAccess`. `listUserWorkspaces` is already concurrent: it
  // rides the gate's own `Promise.all` beside `getWorkspaceContext` and
  // `cookies()`, and it has to, because `resolveActiveOrganization` consumes it.
  // So the genuine win is TWO — `listMembers` and `getAiAccess`, which need only
  // `org.id` and the actor and were written one after the other for no reason.
  // Still the largest single win in the family.
  //
  // `resolveActiveOrganization` stays ABOVE the boundary: it decides the
  // no-active-org state AND supplies the org name the header interpolates.
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

      <Suspense fallback={<SettingsPaneFrame />}>
        <OrgPaneBody
          orgId={org.id}
          orgName={org.name}
          role={current.role}
          isAdmin={isAdmin}
          actorUserId={session.user.id}
          acceptanceVideoEnabled={org.acceptanceVideoEnabled}
          orgWorkspaceCount={orgWorkspaces.length}
          foldInWorkspace={foldInWorkspace}
        />
      </Suspense>
    </div>
  );
}

/**
 * The org pane's two reads, below the boundary and now in ONE wave.
 *
 * `allSettledOrThrow` rather than a bare `Promise.all`: both arms open a
 * transaction, so a rejection on one must not leave the other running
 * unobserved (MOTIR-3066).
 */
async function OrgPaneBody({
  orgId,
  orgName,
  role,
  isAdmin,
  actorUserId,
  acceptanceVideoEnabled,
  orgWorkspaceCount,
  foldInWorkspace,
}: {
  orgId: string;
  orgName: string;
  role: React.ComponentProps<typeof OrgGeneralCard>['role'];
  isAdmin: boolean;
  actorUserId: string;
  acceptanceVideoEnabled: boolean;
  orgWorkspaceCount: number;
  foldInWorkspace: { id: string } | null;
}) {
  const t = await getTranslations('orgAdmin');
  const [{ total: memberCount }, aiAccess] = await allSettledOrThrow([
    organizationsService.listMembers({ organizationId: orgId, actorUserId, limit: 1 }),
    // Acceptance-video card (MOTIR-1635): the toggle is only effective for an org
    // ENTITLED to paid-AI features. That is not the same question as "does it hold
    // a paid plan" (MOTIR-2545): `getAiAccess` returns the inert
    // `notApplicableAiAccess()` sentinel for a self-hosted build AND for a `meta`
    // organization, and reading `hasPaidAiPlan` off it answered "no" for an org
    // the paywall explicitly does not apply to — showing moooon an Upgrade button
    // and disabling its own toggle. `hasAiEntitlement` reads the DTO the way its
    // contract says to, and is the same predicate `AiPaywall` gates on.
    //
    // No `isCloudBilling()` branch here: `getAiAccess` already short-circuits to
    // that sentinel off-cloud, before any read, so the predicate returns true
    // there exactly as the old `: true` arm did — one code path, one place the
    // rule lives.
    billingService.getAiAccess({ actorUserId, organizationId: orgId }),
  ]);
  const hasAcceptancePlan = hasAiEntitlement(aiAccess);

  return (
    <>
      {isAdmin ? (
        <>
          <OrgGeneralCard
            orgId={orgId}
            initialName={orgName}
            role={role}
            workspaceCount={orgWorkspaceCount}
            memberCount={memberCount}
          />

          {/* The live billing "door" (8.1.7, design/billing panel 1) replaces the
              passive placeholder — cloud-only (ADR §6): off-cloud there is no
              billing surface at all, so the card simply doesn't render. */}
          {isCloudBilling() ? <BillingCard /> : null}

          <AcceptanceVideoCard
            orgId={orgId}
            initialEnabled={acceptanceVideoEnabled}
            hasPlan={hasAcceptancePlan}
            canManage={isAdmin}
          />
        </>
      ) : (
        // Panel 5d's forbidden treatment, applied to the ORG-SCOPED sections
        // rather than to the page. The member keeps whatever this page hosts for
        // them below.
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={t('states.forbiddenTitle')}
          description={t('states.forbiddenDescription', { org: orgName })}
        />
      )}

      {foldInWorkspace ? (
        <WorkspaceFoldInSection
          workspaceId={foldInWorkspace.id}
          actorUserId={actorUserId}
          workspaceCount={orgWorkspaceCount}
        />
      ) : null}

      {isAdmin ? <DangerZoneCard /> : null}
    </>
  );
}
