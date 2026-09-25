import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
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
import { orgCan } from '@/lib/organizations/capabilities';
import { isCloudBilling } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { OrgGeneralCard } from './_components/OrgGeneralCard';
import { BillingCard } from './_components/BillingCard';
import { WorkspaceFoldInSection } from './_components/WorkspaceFoldInSection';
import { JobRunsFoldInSection } from './_components/JobRunsFoldInSection';
import { DangerZoneCard } from './_components/DangerZoneCard';

// Organization settings (Story 6.10.5, design/org-admin panel 2) — the
// org-scoped Settings home. Org owner/admin only: a plain org member sees the
// forbidden panel (5d), not the controls. The active org is resolved from the
// org cookie (the shell switcher sets it). NO billing/credit surface here —
// that is 7.12.5 / Epic 8 (only a passive "Coming soon" placeholder).

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  /** ⚠️ READ ONLY BY THE `Job runs` FOLD-IN (Story MOTIR-4843 · MOTIR-4849).
   *  Below the workspace-tier reveal this page hosts that dashboard, and a
   *  dashboard whose tabs, filters and pages are URL-driven needs a URL on the
   *  page that renders it. Every other section here ignores these. */
  searchParams: Promise<{
    tab?: string;
    status?: string;
    page?: string;
    /** MOTIR-6314's deep link names the org to open (the one blocking an account
     *  deletion), which need not be the active one. Honoured only for an org the
     *  viewer belongs to — `resolveActiveOrganization` checks membership. */
    org?: string;
    /** `transfer-ownership` opens the Owner's transfer dialog on arrival
     *  (MOTIR-6313). Ignored for a viewer without `transferOwnership`. */
    dialog?: string;
  }>;
}) {
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
  const [ctx, myWorkspaces, cookieStore, jobsParams] = await Promise.all([
    getWorkspaceContext(),
    workspacesService.listUserWorkspaces(session.user.id),
    cookies(),
    searchParams,
  ]);
  const activeWorkspace = ctx ? (myWorkspaces.find((w) => w.id === ctx.workspaceId) ?? null) : null;
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(
    session.user.id,
    jobsParams.org || preferredOrganizationId(activeWorkspace, orgCookie),
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
  const isAdmin = orgCan(current.role, 'manageOrgSettings');
  // The Danger zone is the OWNER's (design MOTIR-6303 panels 2–3): an Admin holds
  // org settings but not `transferOwnership`, and gets no card at all.
  const canTransfer = orgCan(current.role, 'transferOwnership');

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
  // MOTIR-3448 — allocation row 13: the frame, and (once) a wave.
  //
  // ⚠️ THE WAVE IS GONE, AND SO IS ITS REASON (MOTIR-5172). The asset counted
  // three serial reads here and the genuine win was two — `listMembers` and
  // `getAiAccess`. `getAiAccess` fed exactly one consumer, the acceptance-video
  // card, and that card left this page when the switch moved to
  // `Project settings ▸ Approvals` (`design/org-admin/design-notes.md` panel 7b).
  // A read with no consumer is not kept for symmetry, so the pane is one read.
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
          canTransfer={canTransfer}
          openTransfer={canTransfer && jobsParams.dialog === 'transfer-ownership'}
          actorUserId={session.user.id}
          actorEmail={session.user.email}
          orgWorkspaceCount={orgWorkspaces.length}
          foldInWorkspace={foldInWorkspace}
          jobsParams={jobsParams}
        />
      </Suspense>
    </div>
  );
}

/**
 * The org pane's ONE read, below the boundary.
 *
 * It was two, in one `allSettledOrThrow` wave (MOTIR-3066); the second —
 * `billingService.getAiAccess` — existed only for the acceptance-video card,
 * which MOTIR-5172 removed with the switch's move to the project tier.
 */
async function OrgPaneBody({
  orgId,
  orgName,
  role,
  isAdmin,
  canTransfer,
  openTransfer,
  actorUserId,
  actorEmail,
  orgWorkspaceCount,
  foldInWorkspace,
  jobsParams,
}: {
  orgId: string;
  orgName: string;
  role: React.ComponentProps<typeof OrgGeneralCard>['role'];
  isAdmin: boolean;
  canTransfer: boolean;
  openTransfer: boolean;
  actorUserId: string;
  actorEmail: string;
  orgWorkspaceCount: number;
  foldInWorkspace: { id: string } | null;
  jobsParams: { tab?: string; status?: string; page?: string };
}) {
  const t = await getTranslations('orgAdmin');
  const { total: memberCount } = await organizationsService.listMembers({
    organizationId: orgId,
    actorUserId,
    limit: 1,
  });

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

      {/* Story MOTIR-4843 · MOTIR-4861 — the FOURTH workspace-tier capability's
          fold-in, and the last one to get one. Same condition as the block
          above, so all four surfaces hide and reappear together; a SEPARATE
          section rather than a card inside it, because this is an operator
          surface rather than workspace CONFIG — which is also why the area rail
          gives it a group of its own.

          ⚠️ Gated on `foldInWorkspace` — a WORKSPACE MEMBERSHIP — and never on
          `isAdmin`. §6d gates this page per SECTION, and the source surface
          checks no role at all. */}
      {foldInWorkspace ? (
        <JobRunsFoldInSection
          workspaceId={foldInWorkspace.id}
          actorUserId={actorUserId}
          actorEmail={actorEmail}
          searchParams={jobsParams}
        />
      ) : null}

      {canTransfer ? (
        <DangerZoneCard orgId={orgId} orgName={orgName} openTransfer={openTransfer} />
      ) : null}
    </>
  );
}
