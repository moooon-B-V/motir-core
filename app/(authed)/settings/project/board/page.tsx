import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Columns3, SearchX } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { boardsService } from '@/lib/services/boardsService';
import { BoardNotFoundError } from '@/lib/boards/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { BoardSwitcher } from '../../../boards/_components/BoardSwitcher';
import { BoardConfigEditor, type BoardConfigModel } from './_components/BoardConfigEditor';

// Board settings — server component (Subtask 3.6.3, made PER-BOARD by 3.7.8).
// The board ADMINISTRATION surface: a project admin manages a board's COLUMNS
// (add / rename / reorder / delete) and the COLUMN ↔ STATUS mapping the 3.2.6
// unmapped tray points at, and renames the board. SIBLING of the Workflow editor
// (settings/project/workflow, Story 2.2.5) — Workflow owns statuses +
// transitions; Board owns how those statuses map onto columns.
//
// PER-BOARD (Subtask 3.7.8, per `design/boards/per-board-settings.mock.html`):
// with multiple boards per project (Story 3.7) each board carries its OWN columns
// / mapping / swimlane group-by / WIP, so this page targets the SELECTED board.
// It reads `?board=<id>` (defaulting to the project's default board when absent;
// a board outside the active project/workspace → a tenant-safe not-found, never a
// cross-tenant read — the 3.7.5 guard), builds its model from THAT board's
// projection, and renders a header that NAMES the board + a board switcher
// (`variant="settings"`) so the admin sees which board they're editing and can
// switch (which re-targets `?board=` and re-lays the editor). 3.7.5 already taught
// `boardsService.getBoard` to take a `boardId`, and the 3.6.2 config writes are
// already board-scoped — so this is a UI/URL threading of the selected board, no
// service/schema change.
//
// Mirrors the Workflow page grammar: resolve the active project + the caller's
// admin role (owner == project admin in v1, finding #36 / TODO(6.4)) + the
// board's current config, then hand typed serializable data to the client
// `BoardConfigEditor`. Every WRITE is re-gated server-side in boardsService
// (3.6.2), so a non-owner who reaches the page (read-only) still can't mutate;
// `isAdmin` here only governs whether the edit affordances render.
//
// The initial model is built from the Story-3.1.4 board projection
// (`boardsService.getBoard` — columns + their mapped status KEYS + per-column
// card counts + `unmappedStatuses`) joined to the project's full status list so
// each mapped status resolves to its {id,label} (the projection gives keys; map
// / unmap need the id).

/**
 * The page's `?board=` parsing (Subtask 3.7.8): a blank / whitespace-only value
 * is treated as ABSENT (→ the project's default board), a non-blank value is the
 * selected board id. Exported so the resolution is unit-testable.
 */
export function resolveSelectedBoardId(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

export default async function ProjectBoardSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[52rem]">
        <EmptyState title={t('project.empty.title')} description={t('board.noBoardDescription')} />
      </div>
    );
  }

  // The selected board (Subtask 3.7.8) — `?board=<id>` picks WHICH board to
  // configure; absent → the project's default board.
  const sp = await searchParams;
  const selectedBoardId = resolveSelectedBoardId(sp.board);

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isAdmin = isOwnerRole(role);

  let projection;
  try {
    projection = await boardsService.getBoard(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      selectedBoardId,
    );
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      // A stale / cross-project / cross-workspace `?board=` id → a tenant-safe
      // not-found (3.7.5), with the switcher still present so the admin can pick a
      // real board. When NO `?board=` was supplied the project simply has no
      // default board yet — the original no-board empty state (no switcher to
      // show, since there are no boards).
      if (selectedBoardId) {
        return (
          <BoardSettingsShell projectName={ctx.project.name}>
            <EmptyState
              icon={<SearchX />}
              title={t('board.notFoundTitle')}
              description={t('board.notFoundDescription')}
            />
          </BoardSettingsShell>
        );
      }
      return (
        <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
          <PlainHeader title={t('board.title')} subtitle={t('board.subtitle')} />
          <EmptyState title={t('board.noBoardTitle')} description={t('board.noBoardDescription')} />
        </div>
      );
    }
    throw err;
  }

  // Resolve each column's mapped status KEYS (from the projection) to {id,label}
  // via the project's full status list — map / unmap are keyed by status id.
  const statuses = await workflowsService.listStatusesByProject(ctx.projectId, ctx.workspaceId);
  const statusByKey = new Map(statuses.map((s) => [s.key, s] as const));

  const model: BoardConfigModel = {
    boardId: projection.boardId,
    boardName: projection.name,
    columns: projection.columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      cardCount: c.totalCount,
      statuses: c.statusKeys
        .map((key) => statusByKey.get(key))
        .filter((s): s is (typeof statuses)[number] => s != null)
        .map((s) => ({ id: s.id, label: s.label })),
    })),
    unmapped: projection.unmappedStatuses.map((s) => ({ id: s.id, label: s.label })),
  };

  return (
    <BoardSettingsShell projectName={ctx.project.name} boardName={projection.name}>
      {/* Key by boardId so switching the configured board (the `?board=` change)
          REMOUNTS the editor with the new board's model, rather than leaving its
          mount-seeded column state on the previous board. */}
      <BoardConfigEditor key={model.boardId} model={model} isAdmin={isAdmin} />
    </BoardSettingsShell>
  );
}

// The board-scoped settings shell (Subtask 3.7.8) — the crumb + a head-row whose
// LEFT is the serif title + subtitle and whose RIGHT is the "Configuring board"
// label + the board switcher (`variant="settings"`: switch-only, no New/manage —
// picking a board re-targets `?board=` and re-lays this page). Per
// `design/boards/per-board-settings.mock.html` panel 0.
function BoardSettingsShell({
  projectName,
  boardName,
  children,
}: {
  projectName: string;
  boardName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
      <BoardSettingsHeader projectName={projectName} boardName={boardName} />
      {children}
    </div>
  );
}

async function BoardSettingsHeader({
  projectName,
  boardName,
}: {
  projectName: string;
  boardName?: string;
}) {
  const t = await getTranslations('settings');
  return (
    <header className="flex flex-col gap-2">
      {boardName ? (
        <p className="text-xs text-(--el-text-muted)">
          {t('board.breadcrumb', { project: projectName, board: boardName })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2.5 font-serif text-3xl font-semibold text-(--el-text)">
            <Columns3 className="text-(--el-text-muted) size-6 shrink-0" aria-hidden />
            {t('board.title')}
          </h1>
          <p className="text-(--el-text-muted) max-w-[40rem] font-sans text-sm">
            {t('board.subtitle')}
          </p>
        </div>
        {/* The per-board switcher — NAMES which board is being configured + lets
            the admin switch which board they edit. */}
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <SectionLabel label={t('board.configuringBoardLabel')} />
          <BoardSwitcher variant="settings" />
        </div>
      </div>
    </header>
  );
}

function PlainHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2.5 font-serif text-3xl font-semibold text-(--el-text)">
        <Columns3 className="text-(--el-text-muted) size-6 shrink-0" aria-hidden />
        {title}
      </h1>
      <p className="text-(--el-text-muted) max-w-[40rem] font-sans text-sm">{subtitle}</p>
    </header>
  );
}
