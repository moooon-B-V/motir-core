import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { EditIssueForm } from './_components/EditIssueForm';
import { RelationshipsPanel } from '../_components/RelationshipsPanel';

// The issue edit route (Subtask 2.3.6). Server Component: resolves the active
// project (the shipped active-project model — finding #50, no projects/[key]
// tree), loads the issue DETAIL bundle by its identifier (the [key] segment,
// e.g. "PROD-7") — which carries the item, the project's workflow, and the
// relationship links + readiness — plus the workspace members, then hands them
// to the client EditIssueForm and the EDITABLE relationships block (2.4.5 +
// 2.4.9, user directive: the edit page shows related issues too AND lets an
// editor manage them — same "+ Link issue" add control + per-row remove as the
// detail page — so dependency work happens without leaving the edit surface). Cross-workspace / missing → 404 (no existence leak);
// unauthenticated → /sign-in; no active project → a hint, not a crash.

export default async function EditIssuePage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('issueViews');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('noProjectTitle')} description={t('noProjectEditDescription')} />
      </div>
    );
  }

  const { key } = await params;
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  let detail;
  try {
    detail = await workItemsService.getIssueDetail(ctx.projectId, key, serviceCtx);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) notFound();
    throw err;
  }

  const members = await assignableMembersService.list({
    projectId: ctx.projectId,
    accessLevel: ctx.project.accessLevel,
    ctx: serviceCtx,
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('editIssue')}</h1>
      <EditIssueForm issue={detail.item} workflow={detail.workflow} members={members} />
      <RelationshipsPanel
        blockedBy={detail.blockedBy}
        blocks={detail.blocks}
        relatesTo={detail.relatesTo}
        duplicates={detail.duplicates}
        clones={detail.clones}
        readiness={detail.readiness}
        currentStatus={detail.item.status}
        workflow={detail.workflow}
        editable
        currentItemId={detail.item.id}
        identifier={detail.item.identifier}
      />
    </div>
  );
}
