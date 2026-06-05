import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { parseSort, parseView, serializeSort } from '@/lib/issues/issueListView';
import { IssueListToolbar } from './_components/IssueListToolbar';
import { IssueTreeSection } from './_components/IssueTreeSection';
import { IssueTreeSkeleton } from './_components/IssueTreeSkeleton';

// The project issue index (Story 2.5 · Subtask 2.5.3; view switcher in 2.5.8) —
// the surface the sidebar "Issues" link opens. Server Component: resolves the
// active project, reads `?view` + `?sort` from the URL, renders the "Issues"
// header + the [Filter] · [Tree ▾ / List ▾] · [+ New issue] toolbar immediately,
// then streams the matching table (nested Tree or flat sortable List) inside a
// <Suspense> whose fallback is the skeleton (design/work-items/tree.png panels
// 1 + 3, list.mock.html panel 4). The read + row shaping live in
// IssueTreeSection; a project with no issues renders the drawn empty state there.
//
// 4-layer: the page calls only services (via getActiveProject + the section's
// service reads) — never Prisma directly. View/sort are parsed through the
// `issueListView` whitelist so an unknown column never reaches the read. The
// <Suspense> is keyed by view+sort so a switch/sort re-shows the skeleton while
// the new order streams. Unauthenticated → /sign-in; no active project → a hint.

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">Issues</h1>
        </header>
        <EmptyState
          title="No project selected"
          description="Pick or create a project from the switcher to track its issues."
        />
      </div>
    );
  }

  const { view: rawView, sort: rawSort } = await searchParams;
  const view = parseView(rawView);
  const sort = parseSort(rawSort);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">Issues</h1>
          <p className="text-sm text-(--el-text-muted)">All issues in {ctx.project.name}</p>
        </div>
        <IssueListToolbar view={view} sort={sort} />
      </header>

      <Suspense
        key={`${view}:${serializeSort(sort)}`}
        fallback={<IssueTreeSkeleton flat={view === 'list'} />}
      >
        <IssueTreeSection
          projectId={ctx.projectId}
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          view={view}
          sort={sort}
        />
      </Suspense>
    </div>
  );
}
