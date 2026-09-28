import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleDot } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { ReadyLanes } from './_components/ReadyLanes';
import { ReadyHelpPopover } from './_components/ReadyHelpPopover';
import { ExpansionNudgeBanner } from './_components/ExpansionNudgeBanner';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// The Ready set — the AI dispatch surface (Story 7.0 · Subtask 7.0.6). A Server
// Component that resolves the active project (the established getActiveProject
// pattern, mirroring /items + /dashboard) and reads `workItemsService.listReady`
// + `countReady` DIRECTLY — the server-component 4-layer path; the HTTP endpoints
// (`GET /api/ready` 7.0.4 / `POST /api/ready/next` 7.0.5) are the BYOK CLI /
// external-agent contract, not this page's read.
//
// Renders exactly what design/ready specifies: header (serif title + neutral
// count chip + project subtitle + the "What is this?" predicate popover), then
// — since Story MOTIR-6829 (`ready--lanes.mock.html`) — the LANE SWITCH over one
// full-height pane: Ready to run (the leaves lane, grouped by runnable container)
// or Bugs, each a virtualized, cursor-streamed ReadyList; or the EmptyState
// (panel 3) when BOTH lanes are empty. The `?peek=<key>` quick-view peek
// reuses the SAME IssueQuickView surface /items + the board use (notes.html #7).

export default async function ReadyPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('ready');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  const [leaves, bugs, counts] = await Promise.all([
    workItemsService.listReadyLeaves(ctx.projectId, {}, svcCtx),
    workItemsService.listReadyBugs(ctx.projectId, {}, svcCtx),
    workItemsService.countReadyLanes(ctx.projectId, svcCtx),
  ]);

  const isEmpty = leaves.items.length === 0 && bugs.items.length === 0;
  const countLabel = counts.hasMore
    ? t('countCapped', { count: counts.leaves })
    : t('count', { count: counts.leaves });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
            {isEmpty ? null : <Pill tone="neutral">{countLabel}</Pill>}
          </div>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name, key: ctx.project.identifier })}
          </p>
        </div>
        <ReadyHelpPopover />
      </header>

      <ExpansionNudgeBanner />

      {isEmpty ? (
        <EmptyState
          title={t('empty.title')}
          description={t('empty.body')}
          action={
            <Link href="/items" className={buttonVariants({ variant: 'secondary' })}>
              <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.action')}
            </Link>
          }
        />
      ) : (
        <ReadyLanes
          leaves={leaves}
          bugs={bugs}
          counts={{ leaves: counts.leaves, bugs: counts.bugs }}
        />
      )}

      {/* Quick-view peek (notes.html #7; bug 8.8.2) — a client island that
          watches `?peek` and renders the modal frame + skeleton instantly, then
          client-fetches the item from /api/work-items/peek. Decoupled from this
          page's server render, so opening/closing is a pure shallow URL change
          with no underlying-list refetch. */}
      <IssueQuickViewController />
    </div>
  );
}
