import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Filter } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { NewIssueButton } from '../issues/_components/NewIssueButton';
import { IssueQuickView } from '../issues/_components/IssueQuickView';
import { IssueQuickViewContent } from '../issues/_components/IssueQuickViewContent';
import { IssueQuickViewPanel } from '../issues/_components/IssueQuickViewPanel';
import { BoardContainer } from './_components/BoardContainer';
import { BoardSwitcher } from './_components/BoardSwitcher';

// The Kanban board surface (Story 3.2 · Subtask 3.2.2) — the surface the sidebar
// "Boards" link + the Cmd-K "Go to Boards" entry open (Story 1.5; no nav wiring
// changes). Replaces the old `ProjectStubPage … comingIn="Epic 3"` placeholder.
// Server Component: it resolves the active project, renders the page header +
// toolbar immediately, then hands off to the client `BoardContainer`, which
// fetches the Story-3.1.6 projection (`GET /api/board`) and owns the board-level
// loading / error / no-board states. The page itself does NO data access for the
// board (it's a pure consumer) — the only read here is the workspace members for
// the quick-view peek, and only when `?peek` is present.
//
// Quick-view peek (mirrors /issues, Subtask 2.5.19): a board card click pushes
// `?peek=<identifier>` (via the shared usePeekOpen hook in BoardContainer); when
// that param is present this page mounts the SAME IssueQuickView modal the issue
// list uses — reused, not rebuilt — with the item's fields streamed behind a
// <Suspense>. Closing clears the param. Unauthenticated → /sign-in; no active
// project → a hint.

export default async function BoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ peek?: string; board?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('boards');

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

  // Story 6.4.6 — the active project may be one the actor can no longer browse
  // (e.g. it was made private while pinned). Gate the board read on canBrowse and
  // render the no-access state instead of crashing; canEdit drives the board's
  // read-only (drag-disabled) mode below.
  const caps = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  const sp = await searchParams;
  // The quick-view peek (Subtask 2.5.19, reused) — `?peek=<identifier>` opens the
  // work item in a modal over the board. URL-driven so it's shareable /
  // reload-safe; closing clears the param.
  const peek = sp.peek?.trim() || null;

  // The selected board (Subtask 3.7.5) — `?board=<id>` picks which of the
  // project's boards to show; absent → the project's default board. URL-driven
  // (mirrors `?peek`) so it's shareable / reload-safe; the 3.7.4 switcher writes
  // it. Passed to the client BoardContainer, which fetches that board's
  // projection (`GET /api/board?boardId=`); a stale / cross-project id resolves
  // to a 404 board-not-found, surfaced as the board error state.
  const selectedBoardId = sp.board?.trim() || undefined;

  // Members resolve assignee / reporter ids to display names — for the board
  // cards' assignee avatars (the projection carries only `assigneeId`, Story
  // 3.1.4) AND for the quick-view panel when a peek is open. Resolved once here;
  // the page calls services only (never Prisma) per the 4-layer rule.
  // Assignable users are scoped by access level (6.4.6): a private project lists
  // only its project members; open/limited list the whole workspace.
  const members = await assignableMembersService.list({
    projectId: ctx.projectId,
    accessLevel: ctx.project.accessLevel,
    ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
  });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* The board switcher (Subtask 3.7.4) — at the left of the toolbar,
              before the disabled [Filter] seam + [+ New issue]. It owns its own
              board-list fetch + the `?board=` selection, so it stays present
              across the board's loading / error / empty states. */}
          <BoardSwitcher />
          {/* Group-by slot — BoardContainer portals its GroupByControl here so the
              control sits in this header row (beside the switcher) per the
              multi-board design, while its state stays with the board projection.
              `display:contents` so the portaled control is a direct flex child. */}
          <div id="board-toolbar-groupby-slot" className="contents" />
          {/* Filter is a disabled seam here — Epic 6 wires board filtering. */}
          <Button
            variant="secondary"
            leftIcon={<Filter className="h-4 w-4" />}
            disabled
            title={t('filterComingSoon')}
          >
            {t('filter')}
          </Button>
          <NewIssueButton />
        </div>
      </header>

      <BoardContainer
        members={members}
        activeProjectId={ctx.projectId}
        selectedBoardId={selectedBoardId}
        canEdit={caps.canEdit}
      />

      {/* Quick-view peek — the modal frame mounts when `?peek` is present; the
          item's fields stream behind a <Suspense> whose fallback is the loading
          skeleton. Reuses getIssueDetail's workspace gate + not-found path, so a
          stale / cross-workspace key renders not-found, never a crash. */}
      {peek ? (
        <IssueQuickView peekKey={peek}>
          <Suspense fallback={<IssueQuickViewPanel state="loading" peekKey={peek} />}>
            <IssueQuickViewContent
              projectId={ctx.projectId}
              ctx={{ userId: ctx.userId, workspaceId: ctx.workspaceId }}
              peekKey={peek}
              members={members}
            />
          </Suspense>
        </IssueQuickView>
      ) : null}
    </div>
  );
}
