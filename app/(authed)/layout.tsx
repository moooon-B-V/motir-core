import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { toWorkspaceSummaryDTO } from '@/lib/mappers/workspaceMappers';
import { ToastProvider } from '@/components/ui/Toast';
import { AppLayout } from '@/components/ui/AppLayout';
import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { TopNav } from './_components/TopNav';
import { SidebarNav } from './_components/SidebarNav';
import { WorkspaceSwitcher } from './_components/WorkspaceSwitcher';

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

  const activeWorkspaceId = ctx?.workspaceId ?? null;

  return (
    <ToastProvider>
      <AppLayout
        topNav={
          <TopNav
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            user={{ name: session.user.name, email: session.user.email }}
          />
        }
        sidebar={<SidebarNav activeProject={activeProject} projects={projects} variant="rail" />}
      >
        <div className="px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </AppLayout>

      {/* Mobile off-canvas nav — opened by the TopNav hamburger (<md). The
          drawer is portaled, so it lives at the layout root rather than in an
          AppLayout slot. Its header carries the workspace switcher (the rail's
          workspace switcher lives in the top nav, which the drawer replaces on
          mobile). */}
      <SidebarDrawer
        header={<WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />}
      >
        <SidebarNav activeProject={activeProject} projects={projects} variant="drawer" />
      </SidebarDrawer>
    </ToastProvider>
  );
}
