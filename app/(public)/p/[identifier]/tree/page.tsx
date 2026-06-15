import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicWorkItemTree } from '@/app/(public)/_components/PublicWorkItemTree';

// The public work-item TREE tab (Story 6.14 · Subtask 6.14.10) — a read-only,
// expandable hierarchy (epics → children) of the public projection. SSRs the
// FIRST level of roots (crawlable), then the client island lazily expands each
// node (the at-scale rule). A PRIVATE epic shows the "this epic is not public"
// placeholder on expand for a non-member (6.14.4 enforcement). Server component
// for the first level.

export default async function PublicWorkItemTreePage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let level;
  try {
    level = await publicProjectsService.getProjectTreeLevel(identifier, null, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');

  return (
    <>
      <PublicTabNav identifier={identifier} active="tree" />
      <div className="p-(--spacing-card-padding)">
        <div className="mb-4">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('treeTitle')}</h1>
          <p className="mt-1 text-[13.5px] text-(--el-text-muted)">{t('treeSubtitle')}</p>
        </div>
        {level.rows.length === 0 ? (
          <EmptyState title={t('treeEmptyTitle')} description={t('treeEmptyBody')} />
        ) : (
          <PublicWorkItemTree identifier={identifier} initialLevel={level} />
        )}
      </div>
    </>
  );
}
