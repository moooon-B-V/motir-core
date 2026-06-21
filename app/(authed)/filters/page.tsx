import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { FiltersDirectory } from './_components/FiltersDirectory';

// The Filters directory (Story 6.2 · Subtask 6.2.4) — the project-level manage
// surface for saved filters, per design/work-items/saved-filters.mock.html
// panel 3. Route `/filters`: a sibling of `/items` in the authed shell,
// deliberately NOT a primary sidebar item (the design-recorded deviation — in
// Motir's project-contained filter model the /items toolbar is the home of
// filtering; the directory is reached from the [Saved] dropdown's "View all
// filters" footer and the command palette).
//
// Server Component: resolves the active project, gates on the 6.4 browse
// capability (a non-browsable active project renders the no-access state, not
// the table), and resolves the actor's saved-filter tier ONCE
// (getSavedFilterCapabilities — canShare / isAdmin), handing it to the client
// table as the `viewer` so every per-row action is gated by the same 6.2.1
// matrix the API re-checks. The table itself owns the data (server-searched +
// cursor-paged through the 6.2.1 list API — finding #57's bounded reads).
//
// 4-layer: the page calls services only (getActiveProject +
// projectAccessService), never Prisma.

export default async function FiltersPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('savedFilters');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      </div>
    );
  }

  // Story 6.4.6 — gate on canBrowse; the same one resolve also yields the
  // share + admin tiers the row actions decide over (one round-trip).
  const caps = await projectAccessService.getSavedFilterCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        <p className="text-sm text-(--el-text-muted)">
          {t('subtitle', { project: ctx.project.name })}
        </p>
      </header>
      <FiltersDirectory
        projectKey={ctx.project.identifier}
        viewer={{
          userId: ctx.userId,
          canBrowse: caps.canBrowse,
          canShare: caps.canShare,
          isAdmin: caps.isAdmin,
        }}
      />
    </div>
  );
}
