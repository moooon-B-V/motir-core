// One dashboard's grid (Story 6.3 · Subtask 6.3.5). Loads the dashboard +
// its widgets (access-gated: a private dashboard the actor doesn't own reads
// as a 404, the service's 404-shaped denial → notFound here) plus the
// switcher list and the workspace projects (the config data sources). The
// per-widget data is fetched client-side by each renderer from the 6.3.2
// report endpoints (per-VIEWER gated), so the grid itself is a thin shell.

import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { projectsService } from '@/lib/services/projectsService';
import { DashboardNotFoundError } from '@/lib/dashboards/errors';
import type { DashboardDetailDto } from '@/lib/dto/dashboards';
import { DashboardGrid } from '../_components/DashboardGrid';

export default async function DashboardGridPage({
  params,
}: {
  params: Promise<{ dashboardId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  const { dashboardId } = await params;

  let detail: DashboardDetailDto;
  try {
    detail = await dashboardsService.getDashboard(dashboardId, ctx);
  } catch (err) {
    if (err instanceof DashboardNotFoundError) notFound();
    throw err;
  }

  const [dashboards, projects] = await Promise.all([
    dashboardsService.listDashboards(ctx),
    projectsService.listProjects(ctx.workspaceId, ctx.userId),
  ]);

  const projectLites = projects.map((p) => ({
    id: p.id,
    name: p.name,
    identifier: p.identifier,
  }));

  return <DashboardGrid detail={detail} dashboards={dashboards} projects={projectLites} />;
}
