import { startSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import { SurfaceTitleHost } from '@/components/workItems/titleTranslation/SurfaceTitleHost';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { buildStatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import { SprintReport } from '@/app/(authed)/backlog/_components/SprintReport';
import { EmptyState } from '@/components/ui/EmptyState';
import { pickReportSprints } from '@/lib/reports/sprintPicker';
import { SprintReportSprintPicker } from './_components/SprintReportSprintPicker';
import { ReportPageChrome } from '@/app/(authed)/reports/_components/ReportPageChrome';

// The standalone sprint-report page (Story 4.4 · Subtask 4.4.6) — the report
// reachable for a CLOSED sprint after the complete-modal success state has gone
// (Jira keeps closed-sprint reports at a stable URL). Server Component: it
// resolves the active project, the sprint (within that project — the tenancy +
// status-pill boundary), the report, and the workflow ONCE here (services only,
// never Prisma — 4-layer), then renders the SAME presentational `SprintReport` the
// complete modal uses.
//
// Scope note: the report reads LIVE sprint membership (4.4.4 `getSprintReport`),
// and completion has already MOVED the carried-over issues out, so a closed
// sprint's "Not completed" list is empty here — the rich at-completion view (the
// carried-over rows) is the complete-modal success state, which renders the
// pre-move snapshot. A historical incomplete-at-completion list would need the
// revision trail; logged to PRODECT_FINDINGS as a 4.4.4 follow-up.

export default async function SprintReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;
  const t = await getTranslations('backlog');

  const ctx = await getActiveProject();
  if (!ctx) notFound();

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  // Title translation (Story MOTIR-7738 · MOTIR-8834), started beside the page's reads.
  const titleContext = startSurfaceTranslation(ctx.project, ctx);

  // The picker offers the project's STARTED sprints (active, then completed newest
  // first — Burndown's list, `pickReportSprints`). A path id that is not one of
  // them (another project's sprint, a made-up id, a planned sprint that never
  // started) opens the default sprint instead of a 404 — and says nothing about
  // the id it was given (no existence leak). The redirect keeps the address bar
  // naming the sprint actually shown.
  const sprints = await sprintsService.listByProject(ctx.projectId, accessCtx);
  const { pickerSprints, defaultSprint } = pickReportSprints(sprints);
  if (!defaultSprint) {
    return (
      <ReportPageChrome
        backLabel={t('sprintReport.backToBacklog')}
        backHref="/backlog"
        crumb={t('heading')}
        title={t('sprintReport.heading')}
        subLine={ctx.project.name}
        help="sprintReport"
      >
        <EmptyState
          title={t('sprintReport.noSprintsTitle')}
          description={t('sprintReport.noSprintsBody')}
        />
      </ReportPageChrome>
    );
  }
  const sprint = pickerSprints.some((p) => p.id === id)
    ? sprints.find((s) => s.id === id)
    : undefined;
  if (!sprint) redirect(`/sprints/${defaultSprint.id}/report`);

  // The report's analytics reads, fetched server-side (loading/error ride the
  // page scaffold — Server Component): the velocity (4.6.4) and the sprint CYCLE
  // GRAPH (8.14.4) the Story-4.6 seam presents together (Subtasks 4.6.5 + 4.6.6).
  // Both are bounded reads. A never-started sprint has no window
  // (`SprintNotStartedError`) — the slot then falls back to its client fetch and
  // shows the chart error state.
  const [report, workflow, velocity, cycle] = await Promise.all([
    sprintsService.getSprintReport(id, {}, accessCtx).catch((err) => {
      if (err instanceof SprintNotFoundError) return null;
      throw err;
    }),
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    reportsService.getVelocity({ projectId: ctx.projectId }, accessCtx),
    reportsService.getSprintCycleGraph(id, accessCtx).catch((err) => {
      if (err instanceof SprintNotStartedError) return undefined;
      throw err;
    }),
  ]);
  // The membership check above already vouched for the sprint, so a vanished
  // report is a race; fall back to the default sprint (unless it IS the default —
  // redirecting to itself would loop).
  if (!report) {
    if (id !== defaultSprint.id) redirect(`/sprints/${defaultSprint.id}/report`);
    notFound();
  }

  const statusByKey = buildStatusByKey(workflow.statuses);

  return (
    <SurfaceTitleHost projectKey={ctx.project.identifier} contextRead={titleContext}>
      <ReportPageChrome
        backLabel={t('sprintReport.backToBacklog')}
        backHref="/backlog"
        crumb={t('heading')}
        title={t('sprintReport.title', { name: sprint.name })}
        subLine={ctx.project.name}
        help="sprintReport"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SprintReportSprintPicker sprints={pickerSprints} selectedSprintId={sprint.id} />
            <SurfaceShowOriginalSwitch />
          </div>

          <SurfaceTitlesNotice />

          <SprintReport
            report={report}
            sprint={sprint}
            statusByKey={statusByKey}
            velocity={velocity}
            cycle={cycle}
            fit="page"
          />
        </div>
      </ReportPageChrome>
    </SurfaceTitleHost>
  );
}
