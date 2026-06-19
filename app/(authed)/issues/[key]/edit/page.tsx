import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import { isMotirAiConfigured } from '@/lib/ai/availability';
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
    // A browse denial = the project is hidden from this actor → 404, no leak.
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) {
      // Story 6.8.2 — old-key link: PROD-7/edit after PROD→NIF 308-redirects to
      // NIF-7/edit (the canonical key) so old edit bookmarks keep working;
      // otherwise a real 404.
      const canonical = await resolveAliasedIssueKey(key, serviceCtx);
      if (canonical) permanentRedirect(`/issues/${canonical}/edit`);
      notFound();
    }
    throw err;
  }

  // Story 6.4.6 — the edit form is an EDIT surface, so a read-only actor (viewer
  // / a member on a limited project) must not reach it: the detail page hides the
  // "Edit" link, and a direct nav here bounces back to the read-only detail view
  // (the server would reject every save anyway). Browse already passed above, so
  // the detail page is a valid, viewable destination.
  const { canEdit } = await projectAccessService.getCapabilities(ctx.projectId, serviceCtx);
  if (!canEdit) {
    redirect(`/issues/${detail.item.identifier}`);
  }

  const members = await assignableMembersService.list({
    projectId: ctx.projectId,
    accessLevel: ctx.project.accessLevel,
    ctx: serviceCtx,
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('editIssue')}</h1>
      <EditIssueForm
        issue={detail.item}
        workflow={detail.workflow}
        members={members}
        aiConfigured={isMotirAiConfigured()}
      />
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
