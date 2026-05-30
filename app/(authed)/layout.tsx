import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { toWorkspaceSummaryDTO } from '@/lib/mappers/workspaceMappers';
import { ToastProvider } from '@/components/ui/Toast';
import { TopNav } from './_components/TopNav';

// Layout for every authenticated route. Renders the top-nav on every page
// and wraps the tree in ToastProvider so any client component under
// (authed) can dispatch toasts. The proxy.ts gate already bounces
// unauthenticated requests to /sign-in; we re-check here because the
// proxy only does an optimistic cookie-presence check, and we need the
// session to populate the user menu + workspace switcher anyway.

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  const workspaceModels = await workspacesService.listUserWorkspaces(session.user.id);
  const workspaces = workspaceModels.map(toWorkspaceSummaryDTO);

  // Project switcher data — only meaningful when there's an active
  // workspace. Without one the switcher slot in the top-nav is hidden,
  // so skip the queries entirely.
  const projects = ctx ? await projectsService.listProjects(ctx.workspaceId, session.user.id) : [];
  const activeProject = ctx
    ? await projectsService.getActiveProject(session.user.id, ctx.workspaceId)
    : null;

  return (
    <ToastProvider>
      <TopNav
        workspaces={workspaces}
        activeWorkspaceId={ctx?.workspaceId ?? null}
        projects={projects}
        activeProjectId={activeProject?.id ?? null}
        user={{ name: session.user.name, email: session.user.email }}
      />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </ToastProvider>
  );
}
