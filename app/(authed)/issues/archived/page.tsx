import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { parsePage } from '@/lib/issues/issueListView';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { Locale } from '@/lib/i18n/locales';
import { toArchivedRows } from './_components/archivedRows';
import { ArchivedWorkItemsList } from './_components/ArchivedWorkItemsList';

// The archived work items view (Story 2.9 · Subtask 2.9.3) — the durable surface
// that replaces the transient archive Undo toast, per design/work-items/
// archived.mock.html + design-notes "Archived work items view + Restore UX". A
// dedicated FLAT route (archive is single-node — archived items don't form a
// tree), reachable from the /issues toolbar's [Archived] entry-point.
//
// Server Component: resolves the active project, gates VIEW on `canBrowse` (the
// 2.9.1 access decision — a non-browsable project renders the no-access state,
// the same as /issues), reads `?page` + the archived page (LIMIT/OFFSET, never
// load-all), and shapes rows against the project workflow before handing them to
// the client island. RESTORE is `canEdit`-gated — passed to the island, which
// drops the action column for a browse-only viewer. 4-layer: the page calls
// services only (never Prisma).

export default async function ArchivedIssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('issueViews');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
            {t('archivedHeading')}
          </h1>
        </header>
        <EmptyState title={t('noProjectTitle')} description={t('noProjectListDescription')} />
      </div>
    );
  }

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const caps = await projectAccessService.getCapabilities(ctx.projectId, wsCtx);
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
            {t('archivedHeading')}
          </h1>
        </header>
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const locale = (await getLocale()) as Locale;

  const [workflow, archived] = await Promise.all([
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    workItemsService.listArchivedWorkItems(ctx.projectId, { page }, wsCtx),
  ]);

  const rows = toArchivedRows(archived.items, workflow, locale);

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/issues"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-(--el-link) hover:text-(--el-link-pressed)"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('backToWorkItems')}
      </Link>

      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
          {t('archivedHeading')}
        </h1>
        <p className="text-sm text-(--el-text-muted)">{t('archivedSubtitle')}</p>
      </header>

      {/* Keyed by page so the optimistic-removed set resets on URL-driven paging. */}
      <ArchivedWorkItemsList
        key={archived.page}
        rows={rows}
        total={archived.total}
        page={archived.page}
        pageSize={archived.pageSize}
        canEdit={caps.canEdit}
      />
    </div>
  );
}
