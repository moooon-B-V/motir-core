import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { IssueListToolbar } from './_components/IssueListToolbar';
import { IssueTreeSection } from './_components/IssueTreeSection';
import { IssueTreeSkeleton } from './_components/IssueTreeSkeleton';

// The project issue index (Story 2.5 · Subtask 2.5.3) — the surface the sidebar
// "Issues" link opens (was a stub). Server Component: resolves the active
// project, renders the "Issues" header + the [Filter] · [Tree ▾] · [+ New issue]
// toolbar immediately, then streams the hierarchical tree-table inside a
// <Suspense> whose fallback is the skeleton (design/work-items/tree.png panels
// 1 + 3). The data read + row shaping live in IssueTreeSection; a project with
// no issues renders the drawn empty state there (panel 2).
//
// 4-layer: the page calls only services (via getActiveProject + the section's
// service reads) — never Prisma directly. The list lives at the active project
// (finding #50: no /projects/[key] tree); unauthenticated → /sign-in; no active
// project → a hint, not a crash.

export default async function IssuesPage() {
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">Issues</h1>
          <p className="text-sm text-(--el-text-muted)">All issues in {ctx.project.name}</p>
        </div>
        <IssueListToolbar />
      </header>

      <Suspense fallback={<IssueTreeSkeleton />}>
        <IssueTreeSection
          projectId={ctx.projectId}
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
        />
      </Suspense>
    </div>
  );
}
