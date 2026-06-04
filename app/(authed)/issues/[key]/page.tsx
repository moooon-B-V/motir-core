import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { CoreFieldsPanel, type PersonRef } from './_components/CoreFieldsPanel';
import { IssueExplanation } from './_components/IssueExplanation';

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
  const TypeIcon = ISSUE_TYPE_META[item.kind].icon;

  // Resolve assignee / reporter ids to display names via the workspace member
  // list (the shipped pattern the edit route uses — getIssueDetail carries only
  // ids, no user objects). A member who has since left the workspace resolves to
  // null and renders as "Unassigned" / blank.
  const members = await workspacesService.listMembers(ctx.workspaceId, ctx.userId);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const toPersonRef = (userId: string | null): PersonRef | null => {
    const m = userId ? memberById.get(userId) : undefined;
    return m ? { name: m.name, email: m.email } : null;
  };

  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      {/* Header — type icon · identifier · status · title + Edit link */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <TypeIcon className="text-muted-foreground h-5 w-5" aria-hidden />
          <span className="text-muted-foreground font-mono text-sm">{item.identifier}</span>
          <Pill tone="neutral">{item.status}</Pill>
          <Link
            href={`/issues/${item.identifier}/edit`}
            className="border-border text-foreground hover:bg-surface ml-auto rounded-md border px-3 py-1.5 font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            Edit
          </Link>
        </div>
        <h1 className="text-foreground font-serif text-2xl font-semibold">{item.title}</h1>
      </header>

      {/* Body — two columns; later subtasks fill the regions. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
        <main className="flex flex-col gap-6">
          <section aria-label="Description">
            {item.descriptionMd ? (
              <MarkdownView value={item.descriptionMd} aria-label="Issue description" />
            ) : (
              <p className="text-muted-foreground font-sans text-sm italic">No description.</p>
            )}
          </section>
          <IssueExplanation
            explanationMd={item.explanationMd}
            explanationSource={item.explanationSource}
          />
          {/* 2.4.3: child list. Epic 5 extension slots: comments · activity. */}
        </main>

        <aside className="flex flex-col gap-4">
          <CoreFieldsPanel
            item={item}
            assignee={toPersonRef(item.assigneeId)}
            reporter={toPersonRef(item.reporterId)}
            reporterIsSelf={item.reporterId === ctx.userId}
          />
          {/* 2.4.3: parent breadcrumb. 2.4.4: inline status + assignee controls.
              2.4.5: relationships + readiness badge. Epic 5: custom fields ·
              attachments. */}
        </aside>
      </div>
    </div>
  );
}
