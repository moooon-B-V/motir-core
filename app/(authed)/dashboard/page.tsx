// The dashboards home (Story 6.3 · Subtask 6.3.5) — replaces the 1.1.2 smoke
// landing at /dashboard. The projects-empty branch moves with it (the
// page-comment contract): a workspace with zero projects still onboards to
// "Create your first project" first, since a widget's data source is always a
// project or a project-contained saved filter. With projects, this renders the
// workspace-scoped dashboards list (mine + workspace-shared); the grid lives at
// /dashboard/[dashboardId].

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { getActiveProject } from '@/lib/projects';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';
import { DashboardsHome } from './_components/DashboardsHome';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  // getActiveProject returns null when the workspace has zero projects — the
  // preserved empty-state cue (1.3.4).
  const project = await getActiveProject();
  if (!project) {
    return <ProjectsEmptyState />;
  }

  const dashboards = await dashboardsService.listDashboards(ctx);
  return <DashboardsHome dashboards={dashboards} />;
}
