import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalLink, Filter } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { estimationService } from '@/lib/services/estimationService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { NewIssueButton } from '../issues/_components/NewIssueButton';
import { BacklogContainer } from './_components/BacklogContainer';

// The Backlog / sprint-planning surface (Story 4.2 · Subtask 4.2.3) — Prodect's
// clone of the Jira backlog. The destination the new "Backlog" sidebar item +
// the ⌘K "Go to Backlog" entry open. Server Component: it resolves the active
// project, renders the page header + toolbar immediately, then hands off to the
// client `BacklogContainer`, which fetches the sprint list + the bounded backlog
// page and owns the region-level loading / error / empty states.
//
// The page resolves `workflow` (status key → label/category for the row status
// pills) and `members` (assignee id → name for the avatars) ONCE here — services
// only, never Prisma (4-layer) — and threads them to the client container; the
// bound `WorkItemSummaryDto` rows carry only the keys.
//
// Toolbar: a **View all issues** link deep-linking to the project's issue
// navigator (`/issues`, Story 2.5) — Jira's "View in Issue Navigator" (the
// backlog links OUT to the all-issues list, it does not flatten the grouped
// planning view); the disabled `[Filter]` seam (Epic 6); and `[+ New issue]`.

export default async function BacklogPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('backlog');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [workflow, members, estimationConfig, caps] = await Promise.all([
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    // The estimation config (Subtask 4.3.4) + edit capability, read once here so
    // every inline EstimateBadge on the backlog shares them (no per-row fetch).
    estimationService.getEstimationConfig(ctx.projectId, accessCtx),
    projectAccessService.getCapabilities(ctx.projectId, accessCtx),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View all issues — Jira's "View in Issue Navigator": deep-links to
              the project's /issues List/Tree (every issue across the backlog AND
              all sprints). A plain link, no new view (the navigator is Story 2.5). */}
          <Link
            href="/issues"
            className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t('viewAllIssues')}
          </Link>
          {/* Filter is a disabled seam here — Epic 6 wires backlog filtering. */}
          <Button
            variant="secondary"
            leftIcon={<Filter className="h-4 w-4" />}
            disabled
            title={t('filterComingSoon')}
          >
            {t('filter')}
          </Button>
          <NewIssueButton />
        </div>
      </header>

      <EstimationConfigProvider config={estimationConfig} canEdit={caps.canEdit}>
        <BacklogContainer workflow={workflow} members={members} projectName={ctx.project.name} />
      </EstimationConfigProvider>
    </div>
  );
}
