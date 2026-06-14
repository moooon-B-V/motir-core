import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import type { BurndownSeriesDto } from '@/lib/dto/reports';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import { BurndownReport, type BurndownPickerSprint } from '../_components/BurndownReport';

// The standalone Burndown report page (bug-reports-hub-agile-cards-collapse) —
// the focused per-sprint burndown Jira's Reports menu lists as its own page
// (mirror-product rung 1), replacing the hub's old "all three agile cards →
// /sprints/[id]/report" collapse. Composes EXISTING primitives only (the 4.6.5
// `ReportBurndownSection` / 4.6.2 `BurndownChart`, the 4.6.3 `getBurndownSeries`
// read) in their documented variants — no new design surface, no new
// service/DTO. Server Component (services-only, 4-layer): it resolves the active
// project, lists its started sprints, picks one (URL `?sprint=`, default active
// else most-recent-complete), and reads that sprint's series server-side; the
// client body owns the URL-driven sprint picker.

export default async function BurndownReportPage({
  searchParams,
}: {
  searchParams: Promise<{ sprint?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <ReportPageChrome
        backLabel={t('backToReports')}
        crumb={t('hub.title')}
        title={t('burndown.title')}
        subLine=""
      >
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </ReportPageChrome>
    );
  }

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const sprints = await sprintsService.listByProject(ctx.projectId, accessCtx);

  // A burndown needs a STARTED sprint (a planned sprint has no window — the
  // service 409s). The picker offers active + completed only; the default is the
  // active sprint, else the most recently completed (the list is oldest→newest,
  // so `.at(-1)` of the completes is the most recent — the hub's `agileHref` logic).
  const active = sprints.find((s) => s.state === 'active') ?? null;
  const completed = sprints.filter((s) => s.state === 'complete');
  const defaultSprint = active ?? completed.at(-1) ?? null;

  if (!defaultSprint) {
    return (
      <ReportPageChrome
        backLabel={t('backToReports')}
        crumb={t('hub.title')}
        title={t('burndown.title')}
        subLine={ctx.project.name}
      >
        <EmptyState
          title={t('burndown.noSprintsTitle')}
          description={t('burndown.noSprintsBody')}
        />
      </ReportPageChrome>
    );
  }

  // The picker list: active first, then completed newest→oldest.
  const pickerSprints: BurndownPickerSprint[] = [
    ...(active ? [active] : []),
    ...[...completed].reverse(),
  ].map((s) => ({ id: s.id, name: s.name, state: s.state }));

  const requested = searchParams ? (await searchParams).sprint : undefined;
  const selected = pickerSprints.find((s) => s.id === requested) ?? defaultSprint;

  const burndown: BurndownSeriesDto | undefined = await reportsService
    .getBurndownSeries(selected.id, accessCtx)
    .catch((err) => {
      // Defensive: the picker only offers started sprints, so neither should fire
      // — degrade to the slot's client-fetch/error path rather than 500 the page.
      if (err instanceof SprintNotStartedError || err instanceof SprintNotFoundError) {
        return undefined;
      }
      throw err;
    });

  const subLine = [ctx.project.name, selected.name].join(' · ');

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('burndown.title')}
      subLine={subLine}
    >
      <BurndownReport sprints={pickerSprints} selectedSprintId={selected.id} burndown={burndown} />
    </ReportPageChrome>
  );
}
