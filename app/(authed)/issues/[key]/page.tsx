import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { IssueType } from '@/lib/issues/parentRules';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { CoreFieldsPanel } from './_components/CoreFieldsPanel';
import { ContentSectionCard } from './_components/ContentSectionCard';
import { IssueExplanation } from './_components/IssueExplanation';
import { ParentBreadcrumb } from './_components/ParentBreadcrumb';
import { ChildList } from './_components/ChildList';
import { RelationshipsPanel } from './_components/RelationshipsPanel';

// The issue DETAIL route (Story 2.4 · Subtask 2.4.1). Server Component:
// resolves the active project (the shipped active-project model — finding #50,
// no /projects/[key] tree; sibling of 2.3.6's edit route), loads the aggregate
// `getIssueDetail` by the [key] identifier (e.g. "PROD-7"), and renders the page
// SHELL — header (type icon · identifier · title · status) + the rendered
// description + an "Edit" link to 2.3.6's form. The two-column body reserves the
// regions later subtasks fill (2.4.2 core-fields panel · 2.4.3 breadcrumb +
// child list · 2.4.4 inline status/assignee controls · 2.4.5 relationships +
// readiness) and the Epic-5 extension slots (comments · attachments · custom
// fields · activity). Cross-workspace / missing → 404 (no existence leak);
// unauthenticated → /sign-in; no active project → a hint, not a crash.

export default async function IssueDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState
          title="No project selected"
          description="Pick a project from the switcher to view its issues."
        />
      </div>
    );
  }

  const { key } = await params;
  let detail;
  try {
    detail = await workItemsService.getIssueDetail(ctx.projectId, key, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) notFound();
    throw err;
  }

  const { item } = detail;

  // Members back the inline assignee picker + reporter display (getIssueDetail
  // carries ids only); the workflow (already in the detail bundle) backs the
  // inline status picker's legal-transition set.
  const members = await workspacesService.listMembers(ctx.workspaceId, ctx.userId);

  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      {/* Header — type icon · identifier · parent breadcrumb · status · title +
          Edit link. The breadcrumb (2.4.3) renders the ancestor chain right
          after the identifier, per the detail.png eyebrow. */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <IssueTypeIcon type={item.kind as IssueType} className="h-5 w-5 shrink-0" />
          <span className="text-(--el-text-muted) font-mono text-sm">{item.identifier}</span>
          <ParentBreadcrumb ancestors={detail.ancestors} />
          <Pill tone="neutral">{item.status}</Pill>
          <Link
            href={`/issues/${item.identifier}/edit`}
            className="border-(--el-border) text-(--el-text) hover:bg-(--el-surface) ml-auto rounded-md border px-3 py-1.5 font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            Edit
          </Link>
        </div>
        <h1 className="text-(--el-text) font-serif text-2xl font-semibold">{item.title}</h1>
      </header>

      {/* Body — two columns; later subtasks fill the regions. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
        <main className="flex flex-col gap-6">
          <ContentSectionCard
            title="Description"
            subtitle="what to do"
            editHref={`/issues/${item.identifier}/edit`}
          >
            {item.descriptionMd ? (
              <MarkdownView value={item.descriptionMd} aria-label="Issue description" />
            ) : (
              <p className="font-sans text-sm text-(--el-text-secondary) italic">
                No description yet.
              </p>
            )}
          </ContentSectionCard>
          <IssueExplanation
            explanationMd={item.explanationMd}
            explanationSource={item.explanationSource}
            editHref={`/issues/${item.identifier}/edit`}
          />
          {/* 2.4.5: the relationships section + ready/blocked banner — a left-
              column section card (per the approved mockup), after Explanation.
              2.4.9: editable here (add control + per-row remove). */}
          <RelationshipsPanel
            blockedBy={detail.blockedBy}
            blocks={detail.blocks}
            relatesTo={detail.relatesTo}
            duplicates={detail.duplicates}
            clones={detail.clones}
            readiness={detail.readiness}
            workflow={detail.workflow}
            editable
            currentItemId={item.id}
            identifier={item.identifier}
          />
          {/* 2.4.3: direct children (a leaf renders nothing). Epic 5 extension
              slots: comments · activity. */}
          <ChildList items={detail.children} workflow={detail.workflow} members={members} />
        </main>

        <aside className="flex flex-col gap-4">
          <CoreFieldsPanel
            item={item}
            members={members}
            workflow={detail.workflow}
            parent={detail.parent}
            reporterIsSelf={item.reporterId === ctx.userId}
          />
          {/* The 2.4.3 parent breadcrumb lives in the header (per detail.png),
              not here. Epic 5: custom fields · attachments. */}
        </aside>
      </div>
    </div>
  );
}
