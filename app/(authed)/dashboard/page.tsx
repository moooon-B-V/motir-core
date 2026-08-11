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
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';
import { DashboardsHome } from './_components/DashboardsHome';

// The post-auth landing marker. `/dashboard` is where both credential flows
// land, and BOTH of its branches carry this — so `tests/e2e/_helpers/
// shell-session.ts` has one authoritative "the dashboard has rendered" signal
// to wait on whether or not the workspace has a project yet (MOTIR-2645). It is
// on a bare wrapper rather than on one branch's root so neither branch's own
// layout is touched.
const DASHBOARD_TESTID = 'dashboard-page';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  // getActiveProject returns null when the workspace has zero projects — the
  // preserved empty-state cue (1.3.4).
  const project = await getActiveProject();
  if (!project) {
    return (
      <div data-testid={DASHBOARD_TESTID}>
        <ProjectsEmptyState aiConfigured={isMotirAiConfigured()} />
      </div>
    );
  }

  const dashboards = await dashboardsService.listDashboards(ctx);
  return (
    <div data-testid={DASHBOARD_TESTID}>
      <DashboardsHome dashboards={dashboards} />
    </div>
  );
}
