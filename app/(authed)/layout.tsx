import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { notificationsService } from '@/lib/services/notificationsService';
import { toWorkspaceSummaryDTO } from '@/lib/mappers/workspaceMappers';
import { ToastProvider } from '@/components/ui/Toast';
import { AppLayout } from '@/components/ui/AppLayout';
import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { TopNav } from './_components/TopNav';
import { SidebarNav } from './_components/SidebarNav';
import { WorkspaceSwitcher } from './_components/WorkspaceSwitcher';
import { CommandPaletteProvider } from './_components/CommandPaletteProvider';
import { CreateIssueProvider } from './_components/CreateIssueProvider';
import { ProjectAccessProvider } from './_components/ProjectAccessProvider';
import { AppCommandPalette } from './_components/AppCommandPalette';

// Layout for every authenticated route. Story 1.5 migrates this from a bare
// top-nav + centered <main> into the full AppLayout shell: a full-width top
// nav, a persistent project-nav sidebar (≥md) / off-canvas drawer (<md), and
// the content region. The proxy.ts gate already bounces unauthenticated
// requests to /sign-in; we re-check here because the proxy only does an
// optimistic cookie-presence check, and we need the session to populate the
// user menu + workspace switcher anyway.
//
// Data flow into the shell slots:
//   - TopNav   ← workspaces + active workspace + user (the project switcher
//                MOVED to the sidebar in 1.5.3, so no project data here).
//   - SidebarNav ← the active project + the workspace's projects. SidebarNav
//                renders the ProjectSwitcher / empty-CTA / archived states
//                (PRODECT_FINDINGS #29). The same data feeds the rail and the
//                drawer, so they stay in lockstep.

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  const workspaceModels = await workspacesService.listUserWorkspaces(session.user.id);
  const workspaces = workspaceModels.map(toWorkspaceSummaryDTO);

  // Project data — only meaningful when there's an active workspace. Without
  // one the sidebar hides the project header + project-scoped nav, so skip
  // the queries entirely.
  const projects = ctx ? await projectsService.listProjects(ctx.workspaceId, session.user.id) : [];
  const activeProject = ctx
    ? await projectsService.getActiveProject(session.user.id, ctx.workspaceId)
    : null;

  // The actor's settings-area capabilities on the active project — ONE round-trip
  // (Subtask 6.5.2 `getSettingsCapabilities`) feeding two consumers:
  //   * `canEdit` → ProjectAccessProvider (Story 6.4.6): role-gated affordances
  //     (create buttons, board drag, the issue-detail field pickers) render
  //     disabled with a tooltip for a viewer / a member on a limited project.
  //   * `{ canBrowse, canManage }` → SidebarNav's settings-nav registry filter
  //     when the rail is in the project-settings area (a non-browser sees no nav
  //     entry; admin-only entries — Story 6.6 — gate on canManage).
  // No active project → there's nothing to edit (the affordances are hidden) and
  // no settings area to enter.
  const settingsCaps =
    ctx && activeProject
      ? await projectAccessService.getSettingsCapabilities(activeProject.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : null;
  const canEdit = settingsCaps?.canEdit ?? false;
  const settingsAccess = settingsCaps
    ? { canBrowse: settingsCaps.canBrowse, canManage: settingsCaps.canManage }
    : undefined;

  const activeWorkspaceId = ctx?.workspaceId ?? null;

  // The notification bell's initial unread badge (Subtask 5.7.5) — the cheap
  // partial-index aggregate (5.7.4 getUnreadCount), resolved once here and
  // threaded into TopNav so the badge paints without a client round-trip; the
  // bell then polls + refreshes on navigation. Null when there's no active
  // workspace (the per-workspace bell is hidden).
  const initialUnreadCount = ctx
    ? (
        await notificationsService.getUnreadCount({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      ).unreadCount
    : null;

  // The "Ready" nav badge's readiness count (Subtask 7.0.6) — resolved ONCE
  // here and threaded into both the rail and the drawer SidebarNav, so the badge
  // never double-fetches. Bounded count (see workItemsService.countReady); null
  // when there's no active project (the project-scoped nav is hidden anyway).
  const readyCount =
    ctx && activeProject
      ? await workItemsService.countReady(
          activeProject.id,
          {},
          { userId: ctx.userId, workspaceId: ctx.workspaceId },
        )
      : null;

  return (
    <ToastProvider>
      {/* CommandPaletteProvider owns the ⌘K palette + `?` cheatsheet open state
          and registers their global shortcuts; it wraps the whole shell so the
          TopNav "Search" trigger and the AppCommandPalette below share one
          context. */}
      <CommandPaletteProvider>
        <CreateIssueProvider hasProject={Boolean(activeProject)} canEdit={canEdit}>
          <ProjectAccessProvider canEdit={canEdit}>
            <AppLayout
              topNav={
                <TopNav
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  user={{ name: session.user.name, email: session.user.email }}
                  initialUnreadCount={initialUnreadCount}
                />
              }
              sidebar={
                <SidebarNav
                  activeProject={activeProject}
                  projects={projects}
                  variant="rail"
                  readyCount={readyCount}
                  settingsAccess={settingsAccess}
                />
              }
            >
              <div className="px-4 py-6 sm:px-6 lg:px-8">{children}</div>
            </AppLayout>

            {/* Mobile off-canvas nav — opened by the TopNav hamburger (<md). The
            drawer is portaled, so it lives at the layout root rather than in an
            AppLayout slot. Its header carries the workspace switcher (the rail's
            workspace switcher lives in the top nav, which the drawer replaces on
            mobile). */}
            <SidebarDrawer
              header={
                <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
              }
            >
              <SidebarNav
                activeProject={activeProject}
                projects={projects}
                variant="drawer"
                readyCount={readyCount}
                settingsAccess={settingsAccess}
              />
            </SidebarDrawer>

            {/* The ⌘K palette UI — fed the same workspace/project data the shell
            above already resolved, so navigation + switch actions stay in sync
            without a second fetch. */}
            <AppCommandPalette
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              projects={projects}
              activeProjectId={activeProject?.id ?? null}
              hasProject={Boolean(activeProject)}
              settingsAccess={settingsAccess}
            />
          </ProjectAccessProvider>
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}
