import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { resolveWorkspaceTierDisclosure } from '@/lib/workspaces/tierDisclosure.server';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { RequireTwoFactorCard } from '../../organization/_components/RequireTwoFactorCard';
import { setWorkspaceRequireTwoFactorAction } from './actions';

// Workspace Security (Story MOTIR-1215 · Subtask MOTIR-3647), built to
// `design/org-admin/security-policy.mock.html` panels 2, 5 and 6.
//
// ⚠️ THIS PANE IS TIER-GATED AND ITS SIBLINGS ARE NOT — read the decision rather
// than copying either neighbour. `/github`, `/gitlab` and `/jobs` are
// deliberately UNgated: `SidebarNav.tsx` and `workspace/page.tsx` both record
// why — they are workspace-SCOPED but not workspace-NAMED, and §6 reveals a tier
// rather than relocating every page beneath it.
//
// This pane is workspace-NAMED. Its entire content is *"require 2FA for THIS
// workspace"*, so it belongs with the Name / Members / Danger-zone family:
// gated here, and FOLDED IN to `/settings/organization` below the threshold
// (`WorkspaceFoldInSection`). Copying the `/jobs` pattern would leave a control
// reachable at an address the product has decided not to teach; copying nothing
// would leave it unreachable for exactly the single-workspace orgs that are the
// common case.
//
// 404 rather than a redirect, for the reason `workspace/page.tsx` gives: the
// surface is hidden, not moved, and a redirect would teach the concept by
// putting the route in history.
//
// ⚠️ NO `loading.tsx` at or above this segment. This page DECIDES EXISTENCE, and
// a boundary above it flushes the response head before this function runs —
// pinning the status at 200 and turning the `notFound()` into a 200-with-a-404-
// body. Hoisting the gate into a layout does not recover it. `CLAUDE.md`
// § *A `loading.tsx` may NOT sit above a route that decides existence*;
// `tests/navigation/loading-boundary-guard.test.ts` enforces it.

export default async function WorkspaceSecurityPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { revealed } = await resolveWorkspaceTierDisclosure(session.user.id);
  if (!revealed) notFound();

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');

  const t = await getTranslations('settings');
  const workspace = await workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId);
  if (!workspace) redirect('/dashboard');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('workspace.security.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('workspace.security.subtitle', { workspace: workspace.name })}
        </p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <WorkspaceSecurityBody
          workspaceId={ctx.workspaceId}
          workspaceName={workspace.name}
          actorUserId={ctx.userId}
        />
      </Suspense>
    </div>
  );
}

/** The pane's reads, below the boundary. */
async function WorkspaceSecurityBody({
  workspaceId,
  workspaceName,
  actorUserId,
}: {
  workspaceId: string;
  workspaceName: string;
  actorUserId: string;
}) {
  const t = await getTranslations('orgAdmin');
  // `allSettledOrThrow`, never a bare `Promise.all`: both arms open a
  // transaction, so a rejection on one must not leave the other running
  // unobserved (MOTIR-3066). `tests/navigation/settings-workspace-org-arrival.test.ts`
  // enforces it for every pane in this family.
  const [policy, role] = await allSettledOrThrow([
    twoFactorPolicyService.getWorkspacePolicy(workspaceId, actorUserId),
    workspacesService.getMemberRole(actorUserId, workspaceId),
  ]);

  return (
    <RequireTwoFactorCard
      // ⚠️ The workspace's OWN value, never the effective one. Keeping the two
      // operands apart is what lets the organization's policy be switched off
      // later without dropping a requirement this workspace chose for itself
      // (MOTIR-3644 stores two columns for exactly this).
      requiresTwoFactor={policy.requiresTwoFactor}
      lockedBy={policy.lockedByOrganization ? policy.organizationName : null}
      description={t('security.cardBodyWorkspace')}
      stateOnLabel={t('security.stateOnWorkspace', { workspace: workspaceName })}
      canManage={isWorkspaceManager(role)}
      tierName={workspaceName}
      onSave={setWorkspaceRequireTwoFactorAction}
    />
  );
}
