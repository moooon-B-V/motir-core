import { type ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
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
import { ShellTierNav } from './_components/ShellTierNav';
import { CommandPaletteProvider } from './_components/CommandPaletteProvider';
import { CreateIssueProvider } from './_components/CreateIssueProvider';
import { ProjectAccessProvider } from './_components/ProjectAccessProvider';
import { ReportProvider } from './_components/ReportProvider';
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

  // The active ORGANIZATION (Story 6.10.5 — the shell org control). It must
  // agree with the active WORKSPACE: a user who belongs to workspaces across
  // MULTIPLE orgs (e.g. they accepted an invite into another org's workspace)
  // has an active org === the org that owns the workspace they're actually in,
  // so the shell's org + workspace tiers never disagree. The org cookie is only
  // the fallback when there's no active workspace (e.g. an org-only member);
  // the service re-validates membership, so a stale/forged id falls back to the
  // user's first org. PROGRESSIVE DISCLOSURE: the org is ALWAYS the anchor, but
  // the WORKSPACE switcher shows only when the active org has ≥2 workspaces — so
  // the workspace list handed to the shell is scoped to the active org, and ITS
  // length is the reveal test (in ShellTierNav).
  const orgCookie = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const activeWorkspaceModel = ctx
    ? (workspaceModels.find((w) => w.id === ctx.workspaceId) ?? null)
    : null;
  const preferredOrgId = activeWorkspaceModel?.organizationId ?? orgCookie;
  const currentOrg = await organizationsService.resolveActiveOrganization(
    session.user.id,
    preferredOrgId,
  );
  const activeOrg = currentOrg
    ? {
        id: currentOrg.organization.id,
        name: currentOrg.organization.name,
        slug: currentOrg.organization.slug,
        role: currentOrg.role,
      }
    : null;
  const orgs = currentOrg ? await organizationsService.listUserOrganizations(session.user.id) : [];
  const scopedWorkspaceModels = activeOrg
    ? workspaceModels.filter((w) => w.organizationId === activeOrg.id)
    : workspaceModels;
  const workspaces = scopedWorkspaceModels.map(toWorkspaceSummaryDTO);

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
  // The project-admin MANAGE gate — the work-item ⋯ menu's Delete action (2.8.4)
  // consumes it via ProjectAccessProvider, mirroring deleteWorkItem's assertCanManage.
  const canManage = settingsCaps?.canManage ?? false;
  const settingsAccess = settingsCaps
    ? { canBrowse: settingsCaps.canBrowse, canManage: settingsCaps.canManage }
    : undefined;

  // The discoverable "Build in public" entry point (Story 6.17 · Subtask 6.17.3)
  // — shown only to a project ADMIN on a project that is NOT yet `public`. Gating
  // here (server-side) means the PRIMARY header button (TopNav) needs no client
  // access read, and a single `router.refresh()` after going public re-renders
  // this tree to hide it (the 6.17.4 status badge then takes the header slot).
  // Null = no entry point (no project / non-admin / already public).
  const buildInPublicProjectKey =
    canManage && activeProject && activeProject.accessLevel !== 'public'
      ? activeProject.identifier
      : null;

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
          <ProjectAccessProvider canEdit={canEdit} canManage={canManage}>
            {/* ReportProvider (Subtask 6.11.7) owns the in-app report-widget
                modal + open state, mounted once so the top-nav and inbox-header
                "Report" triggers drive the same dialog. The widget posts to the
                6.11.4 intake for the active project; mounted only when there's a
                project the actor can edit (the intake rejects a viewer 403). */}
            <ReportProvider projectKey={activeProject?.identifier ?? null} canEdit={canEdit}>
              <AppLayout
                topNav={
                  <TopNav
                    activeOrg={activeOrg}
                    orgs={orgs}
                    workspaces={workspaces}
                    activeWorkspaceId={activeWorkspaceId}
                    user={{ name: session.user.name, email: session.user.email }}
                    initialUnreadCount={initialUnreadCount}
                    buildInPublicProjectKey={buildInPublicProjectKey}
                  />
                }
                sidebar={
                  <SidebarNav
                    activeProject={activeProject}
                    projects={projects}
                    variant="rail"
                    readyCount={readyCount}
                    settingsAccess={settingsAccess}
                    user={{ name: session.user.name, email: session.user.email }}
                  />
                }
              >
                <div className="px-4 py-6 sm:px-6 lg:px-8">{children}</div>
              </AppLayout>

              {/* Mobile off-canvas nav — opened by the TopNav hamburger (<md). The
            drawer is portaled, so it lives at the layout root rather than in an
            AppLayout slot. Its header carries the same tenancy-tier cluster (org
            control + the workspace switcher at ≥2 workspaces) the top nav shows,
            since the drawer replaces the top nav on mobile. */}
              <SidebarDrawer
                header={
                  <ShellTierNav
                    activeOrg={activeOrg}
                    orgs={orgs}
                    workspaces={workspaces}
                    activeWorkspaceId={activeWorkspaceId}
                  />
                }
              >
                <SidebarNav
                  activeProject={activeProject}
                  projects={projects}
                  variant="drawer"
                  readyCount={readyCount}
                  settingsAccess={settingsAccess}
                  user={{ name: session.user.name, email: session.user.email }}
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
            </ReportProvider>
          </ProjectAccessProvider>
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}
