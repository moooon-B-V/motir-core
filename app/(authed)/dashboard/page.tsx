// The dashboards home (Story 6.3 · Subtask 6.3.5) — replaces the 1.1.2 smoke
// landing at /dashboard. It renders the workspace-scoped dashboards list (mine
// + workspace-shared); the grid lives at /dashboard/[dashboardId].
//
// ⚠️ THE PROJECTS-EMPTY BRANCH IS GONE (MOTIR-4872). This comment used to say
// "a workspace with zero projects still onboards to 'Create your first
// project' first", which was true and is now unreachable: every member is
// inside a project (MOTIR-4870), so a widget's data source — always a project
// or a project-contained saved filter — always exists.

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { getActiveProject } from '@/lib/projects';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { DashboardsHome } from './_components/DashboardsHome';

// The "the dashboards page has rendered" marker, on BOTH branches — a bare
// wrapper rather than one branch's root, so neither branch's own layout is
// touched.
//
// ⚠️ `/dashboard` IS NO LONGER A POST-AUTH LANDING. It was, for both credential
// flows, and this comment said so; MOTIR-2654 moved sign-IN to the landing and
// MOTIR-2921 moved sign-UP after it, so BOTH now land on `AUTHED_LANDING_PATH`
// — `/workbench` since MOTIR-4782 — and settle on its `workbench-page` marker
// (`tests/e2e/_helpers/shell-session.ts`, MOTIR-2645's authoritative-signal
// contract; `docs/decisions/home-scope.md` §2.3).
// `/dashboard` keeps its route and its own rail entry, and is reached by
// navigating to it. The marker stays for a spec that lands here deliberately.
const DASHBOARD_TESTID = 'dashboard-page';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  // UNREACHABLE for a signed-in reader (MOTIR-4870). The guard stays because
  // the type does — the only null left is a session-less request, already
  // answered above — and it redirects rather than rendering.
  const project = await getActiveProject();
  if (!project) redirect('/sign-in');

  const dashboards = await dashboardsService.listDashboards(ctx);
  return (
    <div data-testid={DASHBOARD_TESTID}>
      <DashboardsHome dashboards={dashboards} />
    </div>
  );
}
