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

// The "the dashboards page has rendered" marker, on BOTH branches — a bare
// wrapper rather than one branch's root, so neither branch's own layout is
// touched.
//
// ⚠️ `/dashboard` IS NO LONGER A POST-AUTH LANDING. It was, for both credential
// flows, and this comment said so; MOTIR-2654 moved sign-IN to `/home` and
// MOTIR-2921 moved sign-UP after it, so BOTH now land on `/home` and settle on
// its `home-page` marker (`tests/e2e/_helpers/shell-session.ts`, MOTIR-2645's
// authoritative-signal contract; `docs/decisions/home-scope.md` §2.3).
// `/dashboard` keeps its route and its own rail entry, and is reached by
// navigating to it. The marker stays for a spec that lands here deliberately.
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
