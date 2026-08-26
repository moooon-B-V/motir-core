import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveWorkspaceTierDisclosure } from '@/lib/workspaces/tierDisclosure.server';
import { EmptyState } from '@/components/ui/EmptyState';
import { NameCard } from './_components/NameCard';
import { MembersCard } from './_components/MembersCard';
import { DangerZoneCard } from './_components/DangerZoneCard';

// Workspace settings — server component. Reads the active workspace
// context, loads the workspace + member list through the service layer,
// and hands typed data to three client cards. All mutations go through
// Server Actions (actions.ts), not client fetches; the only client fetch
// is the Invite Modal POST to the existing 1.2.5 invite endpoint.

export default async function WorkspaceSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  // PROGRESSIVE DISCLOSURE (MOTIR-3502 · `docs/decisions/organization-tier.md`
  // §6d). Below the reveal threshold the workspace tier is not a thing the
  // product has told this user about, so this AREA does not exist: its Name /
  // Members / Danger-zone sections are folded into `/settings/organization`
  // instead. 404 rather than a redirect — the surface is hidden, not moved, and
  // a redirect would still teach the concept by putting the route in history.
  //
  // The gate is HERE, in the page, and it must stay here: a `loading.tsx`
  // anywhere above this segment flushes the response head before this function
  // runs and pins the status at 200, and hoisting the check into a `layout.tsx`
  // does NOT recover it (resolving the layout is what releases the fallback).
  // See CLAUDE.md § *A `loading.tsx` may NOT sit above a route that decides
  // existence*; `tests/navigation/loading-boundary-guard.test.ts` enforces the
  // absence of such a boundary.
  //
  // The sub-routes below this one — `/github`, `/gitlab`, `/jobs` — are
  // deliberately NOT gated. They are workspace-SCOPED but not workspace-NAMED,
  // and §6 reveals a tier rather than relocating every page beneath it.
  const { revealed } = await resolveWorkspaceTierDisclosure(session.user.id);
  if (!revealed) notFound();

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    // No active workspace (the user left/deleted their last one). Show the
    // create-first-workspace empty state — the top-nav switcher's Create
    // entry is the action surface.
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title={t('workspace.empty.title')}
          description={t('workspace.empty.description')}
        />
      </div>
    );
  }

  const workspace = await workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId);
  if (!workspace) redirect('/dashboard');

  const members = await workspacesService.listMembers(ctx.workspaceId, ctx.userId);
  const memberCount = members.length;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('workspace.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('workspace.subtitle')}</p>
      </header>

      <NameCard initialName={workspace.name} />

      <MembersCard
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        members={members}
        currentUserId={ctx.userId}
      />

      <DangerZoneCard workspaceName={workspace.name} isLastMember={memberCount <= 1} />
    </div>
  );
}
