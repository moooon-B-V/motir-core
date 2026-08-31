import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { DISPATCH_RUN_LIVE_STATUSES, DISPATCH_RUN_PAST_STATUSES } from '@/lib/runs/timeline';
import { RunsIndex } from './_components/RunsIndex';
import { RunsIndexSkeleton } from './_components/RunsIndexSkeleton';

// THE RUNS INDEX (Story MOTIR-1789 · MOTIR-3923) — every run this project has
// made, current and past. The surface that makes a run FINDABLE at all: before
// it, every door into a run started from something the reader already held.
//
// Renders `design/runs/runs-index.mock.html`. A Server Component that resolves
// the active project the established way (`getActiveProject`, as /ready and
// /items do) and reads `dispatchRunService` DIRECTLY — the server-component
// 4-layer path. `GET /api/projects/[key]/dispatch-runs` is the CLIENT's read for
// paging and polling, not this page's first paint.
//
// ⚠️ TWO HEADED SECTIONS, NOT A SWITCH — `design-notes.md` § `/runs`. A person
// arrives asking one of exactly two questions, *what is happening right now* or
// *what happened*, and the two are read differently: the first is watched, the
// second is searched. Two sections answer both without a click and without
// hiding either. The card that planned this specified a `Segmented` switch; the
// design merged after it and overrules it, and the card is amended on the record.
//
// ⚠️ AND NO `loading.tsx` HERE. `design/shell/design-notes.md` § the
// navigation-pending grammar settles it for the whole group: every page's frame
// is its own in-page <Suspense>, placed AFTER the page's own gate, and no
// `loading.tsx` is added under `app/(authed)` at all. The boundary below sits
// after the session + project gates for exactly that reason.

/** One page of past runs — the read's own default, and the design's number. */
const PAGE = 25;

export default async function RunsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('runs');
  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
            {t('indexHeading')}
          </h1>
        </header>
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('indexHeading')}</h1>
        <p className="text-sm text-(--el-text-secondary)">
          {t('indexSubtitle', { project: ctx.project.name })}
        </p>
      </header>
      <Suspense fallback={<RunsIndexSkeleton />}>
        <RunsIndexData
          projectKey={ctx.project.identifier}
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
        />
      </Suspense>
    </div>
  );
}

/**
 * The read, behind the boundary.
 *
 * ⚠️ THE TWO SECTIONS ARE TWO READS, and that is cheaper than it looks: live
 * runs are bounded by how many agents are running, so the first is short by
 * construction. Filtering one list client-side would mean asking for enough PAST
 * runs to be sure the live ones were included, which on an append-only list that
 * grows for ever is a read with no bound.
 *
 * ⚠️ A FAILED READ IS NOT AN EMPTY ONE. `design-notes.md` § panel 5 keeps them
 * separate faces — *we could not load this* and *nothing has run* are opposite
 * facts — so the catch resolves to a flag the island renders its own error for,
 * rather than throwing into a boundary that would replace the whole page.
 */
async function RunsIndexData({
  projectKey,
  userId,
  workspaceId,
}: {
  projectKey: string;
  userId: string;
  workspaceId: string;
}) {
  const ctx = { userId, workspaceId };
  const [live, past] = await Promise.all([
    dispatchRunService
      .listRunsForProject(
        projectKey,
        { take: PAGE, statuses: [...DISPATCH_RUN_LIVE_STATUSES] },
        ctx,
      )
      .catch(() => null),
    dispatchRunService
      .listRunsForProject(
        projectKey,
        { take: PAGE, statuses: [...DISPATCH_RUN_PAST_STATUSES] },
        ctx,
      )
      .catch(() => null),
  ]);

  return (
    <RunsIndex projectKey={projectKey} initialLive={live} initialPast={past} pageSize={PAGE} />
  );
}
