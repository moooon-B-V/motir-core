import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Columns3 } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { boardsService } from '@/lib/services/boardsService';
import { BoardNotFoundError } from '@/lib/boards/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { BoardConfigEditor, type BoardConfigModel } from './_components/BoardConfigEditor';

// Board settings — server component (Subtask 3.6.3). The board ADMINISTRATION
// surface: a project admin manages the default board's COLUMNS (add / rename /
// reorder / delete) and the COLUMN ↔ STATUS mapping the 3.2.6 unmapped tray
// points at, and renames the board. SIBLING of the Workflow editor
// (settings/project/workflow, Story 2.2.5) — Workflow owns statuses +
// transitions; Board owns how those statuses map onto columns.
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
// / unmap need the id). A project predating the 3.1.2 board seed has no board →
// a no-board EmptyState (the SSR analogue of the design's error state).

export default async function ProjectBoardSettingsPage() {
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

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isAdmin = isOwnerRole(role);

  let projection;
  try {
    projection = await boardsService.getBoard(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      return (
        <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
          <PageHeader title={t('board.title')} subtitle={t('board.subtitle')} />
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
    <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
      <PageHeader title={t('board.title')} subtitle={t('board.subtitle')} />
      <BoardConfigEditor model={model} isAdmin={isAdmin} />
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
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
