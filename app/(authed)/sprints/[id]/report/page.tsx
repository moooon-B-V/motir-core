import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { buildStatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import { SprintReport } from '@/app/(authed)/backlog/_components/SprintReport';

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

  // The sprint must belong to the active project — keeps the status-pill workflow
  // correct and tenant-gates the lookup (a foreign sprint 404s).
  const sprints = await sprintsService.listByProject(ctx.projectId, accessCtx);
  const sprint = sprints.find((s) => s.id === id);
  if (!sprint) notFound();

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
  if (!report) notFound();

  const statusByKey = buildStatusByKey(workflow.statuses);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/backlog"
          className="inline-flex w-fit items-center gap-1 text-sm text-(--el-text-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('sprintReport.backToBacklog')}
        </Link>
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
          {t('sprintReport.title', { name: sprint.name })}
        </h1>
      </div>

      <SprintReport
        report={report}
        sprint={sprint}
        statusByKey={statusByKey}
        velocity={velocity}
        cycle={cycle}
      />
    </div>
  );
}
