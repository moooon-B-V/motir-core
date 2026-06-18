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
import { ReadyList } from './_components/ReadyList';
import { ReadyHelpPopover } from './_components/ReadyHelpPopover';
import { IssueQuickViewController } from '../issues/_components/IssueQuickViewController';

// The Ready set — the AI dispatch surface (Story 7.0 · Subtask 7.0.6). A Server
// Component that resolves the active project (the established getActiveProject
// pattern, mirroring /issues + /dashboard) and reads `workItemsService.listReady`
// + `countReady` DIRECTLY — the server-component 4-layer path; the HTTP endpoints
// (`GET /api/ready` 7.0.4 / `POST /api/ready/next` 7.0.5) are the BYOK CLI /
// external-agent contract, not this page's read.
//
// Renders exactly what design/ready specifies: header (serif title + neutral
// count chip + project subtitle + the "What is this?" predicate popover), then
// the flat dispatch list (ReadyList — virtualized + cursor-streamed), or the
// EmptyState (panel 3) when nothing is ready. The `?peek=<key>` quick-view peek
// reuses the SAME IssueQuickView surface /issues + the board use (notes.html #7).

export default async function ReadyPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('ready');

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

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  const [ready, count] = await Promise.all([
    workItemsService.listReady(ctx.projectId, {}, svcCtx),
    workItemsService.countReady(ctx.projectId, {}, svcCtx),
  ]);

  const isEmpty = ready.items.length === 0;
  const countLabel = count.hasMore
    ? t('countCapped', { count: count.count })
    : t('count', { count: count.count });

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

      {isEmpty ? (
        <EmptyState
          title={t('empty.title')}
          description={t('empty.body')}
          action={
            <Link href="/issues" className={buttonVariants({ variant: 'secondary' })}>
              <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.action')}
            </Link>
          }
        />
      ) : (
        <ReadyList initialItems={ready.items} initialCursor={ready.nextCursor} />
      )}

      {/* Quick-view peek (notes.html #7; bug 8.8.2) — a client island that
          watches `?peek` and renders the modal frame + skeleton instantly, then
          client-fetches the item from /api/issues/peek. Decoupled from this
          page's server render, so opening/closing is a pure shallow URL change
          with no underlying-list refetch. */}
      <IssueQuickViewController />
    </div>
  );
}
