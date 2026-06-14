import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { VelocityChart } from '@/app/(authed)/backlog/_components/VelocityChart';
import { ReportPageChrome } from '../_components/ReportPageChrome';

// The standalone Velocity report page (bug-reports-hub-agile-cards-collapse) —
// the focused, CROSS-SPRINT velocity report Jira's Reports menu lists as its own
// page (mirror-product rung 1). Velocity is project-level history, not a
// per-sprint view, so it had no business hiding behind one sprint's report URL
// (the bug). Composes EXISTING primitives only: the 4.6.6 `VelocityChart` over
// the 4.6.4 `getVelocity` cross-sprint read — no new design surface, no new
// service/DTO. Server Component (services-only, 4-layer); the chart owns its own
// low-history state (≤1 completed sprint), so no controls are needed.

export default async function VelocityReportPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <ReportPageChrome
        backLabel={t('backToReports')}
        crumb={t('hub.title')}
        title={t('velocity.title')}
        subLine=""
      >
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </ReportPageChrome>
    );
  }

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const velocity = await reportsService.getVelocity({ projectId: ctx.projectId }, accessCtx);

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('velocity.title')}
      subLine={ctx.project.name}
    >
      <VelocityChart velocity={velocity} />
    </ReportPageChrome>
  );
}
