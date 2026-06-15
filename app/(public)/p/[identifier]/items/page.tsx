import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicWorkItemList } from '@/app/(public)/_components/PublicWorkItemList';

// The public Work items tab (Story 6.12 · Subtask 6.12.4 · design Panel 2) — a
// paginated, read-only list of the public projection (same stripped fields as
// the board). SSRs the first page (crawlable), then the client island lazily
// pages the rest (the at-scale rule). Server component for the first page.

export default async function PublicWorkItemsPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let page;
  try {
    page = await publicProjectsService.getWorkItems(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');

  return (
    <>
      <PublicTabNav identifier={identifier} active="items" />
      <div className="p-(--spacing-card-padding)">
        <div className="mb-4">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
            {t('workItemsTitle')}
          </h1>
          <p className="mt-1 text-[13.5px] text-(--el-text-muted)">{t('workItemsSubtitle')}</p>
        </div>
        {page.items.length === 0 ? (
          <EmptyState title={t('workItemsEmptyTitle')} description={t('workItemsEmptyBody')} />
        ) : (
          <PublicWorkItemList
            identifier={identifier}
            initialItems={page.items}
            initialCursor={page.nextCursor}
          />
        )}
      </div>
    </>
  );
}
