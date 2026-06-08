'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Check,
  CircleCheck,
  GripVertical,
  Lock,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { keyBetween } from '@/lib/workItems/positioning';

// BoardConfigEditor (Subtask 3.6.3) — the board-administration surface, per
// `design/boards/board-config.mock.html` (3.6.1), consuming the 3.6.2 REST API.
// A pure client consumer of the column-config endpoints (the board UI's own
// fetch idiom, mirroring BoardContainer / ColumnActionsMenu — NOT a server
// action): every write is optimistic-with-reconcile and reverts to a snapshot +
// toasts on failure. The server re-gates every write (boardsService, 3.6.2), so
// `isAdmin` here only governs whether the edit affordances render.
//
// Three paths configure the board, all hitting the same 3.6.2 writes:
//   - column manager: add / rename / reorder (dnd-kit sortable) / delete a column
//   - status mapping: drag a status chip onto a column (map = MOVE), OR a
//     per-column "Add status" picker menu (the non-drag KEYBOARD path, finding
//     #35); the chip's `×` (or dropping it on the rail) unmaps it
//   - board rename: an auto-save Input with a Saving…/Saved reconcile chip
//
// The mapping invariant (`@@unique([boardId, statusId])`, 3.1.1): a status sits
// in AT MOST ONE column, so mapping is a MOVE — the optimistic helpers remove a
// status from wherever it is before placing it, and the 3.6.2 service does the
// transactional delete-then-create. Unmapping returns it to the rail; work items
// are hidden from the board but never deleted (a card's column is derived from
// its status — config never touches work items).
//
// Colour strictly `--el-*` (finding #54); shape via element tokens (finding
// shape-swap); the warning hue lives in a small icon + count badge, never a
// tinted page surface, and the drop target pairs the accent tint with a ring
// (never colour-alone, finding #35).

export interface StatusLite {
  id: string;
  label: string;
}

export interface BoardConfigColumn {
  id: string;
  name: string;
  /** Fractional-index sort key (opaque string). */
  position: string;
  /** The column's mapped statuses, in workflow order. */
  statuses: StatusLite[];
  /** Full count of work items in this column's mapped statuses (the delete guard). */
  cardCount: number;
}

export interface BoardConfigModel {
  boardId: string;
  boardName: string;
  columns: BoardConfigColumn[];
  unmapped: StatusLite[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// ── Pure optimistic-state helpers (exported for the component test) ──────────

/** Remove a status from wherever it lives (rail or any column). */
function detachStatus(
  columns: BoardConfigColumn[],
  unmapped: StatusLite[],
  statusId: string,
): { columns: BoardConfigColumn[]; unmapped: StatusLite[]; status: StatusLite | null } {
  let status = unmapped.find((s) => s.id === statusId) ?? null;
  const nextUnmapped = unmapped.filter((s) => s.id !== statusId);
  const nextColumns = columns.map((c) => {
    const hit = c.statuses.find((s) => s.id === statusId);
    if (hit) status = hit;
    return hit ? { ...c, statuses: c.statuses.filter((s) => s.id !== statusId) } : c;
  });
  return { columns: nextColumns, unmapped: nextUnmapped, status };
}

/** Optimistically MAP a status into a column (a MOVE: detach first, then append). */
export function mapStatusOptimistic(
  columns: BoardConfigColumn[],
  unmapped: StatusLite[],
  statusId: string,
  toColumnId: string,
): { columns: BoardConfigColumn[]; unmapped: StatusLite[] } {
  const d = detachStatus(columns, unmapped, statusId);
  if (!d.status) return { columns, unmapped };
  const status = d.status;
  return {
    unmapped: d.unmapped,
    columns: d.columns.map((c) =>
      c.id === toColumnId ? { ...c, statuses: [...c.statuses, status] } : c,
    ),
  };
}

/** Optimistically UNMAP a status (detach from its column, return to the rail). */
export function unmapStatusOptimistic(
  columns: BoardConfigColumn[],
  unmapped: StatusLite[],
  statusId: string,
): { columns: BoardConfigColumn[]; unmapped: StatusLite[] } {
  const d = detachStatus(columns, unmapped, statusId);
  if (!d.status) return { columns, unmapped };
  return { columns: d.columns, unmapped: [...d.unmapped, d.status] };
}

/** Compute the reordered column list + the moved column's new fractional index. */
export function computeColumnReorder(
  columns: BoardConfigColumn[],
  activeId: string,
  overId: string,
): { columns: BoardConfigColumn[]; position: string } | null {
  const oldIndex = columns.findIndex((c) => c.id === activeId);
  const overIndex = columns.findIndex((c) => c.id === overId);
  if (oldIndex < 0 || overIndex < 0 || oldIndex === overIndex) return null;
  const without = columns.filter((c) => c.id !== activeId);
  const insertAt = without.findIndex((c) => c.id === overId) + (oldIndex < overIndex ? 1 : 0);
  const prev = without[insertAt - 1]?.position ?? null;
  const next = without[insertAt]?.position ?? null;
  const position = keyBetween(prev, next);
  const moved = { ...columns[oldIndex]!, position };
  return {
    columns: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)],
    position,
  };
}

// ── Main editor ─────────────────────────────────────────────────────────────

export function BoardConfigEditor({
  model,
  isAdmin,
}: {
  model: BoardConfigModel;
  isAdmin: boolean;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();

  const [columns, setColumns] = useState<BoardConfigColumn[]>(model.columns);
  const [unmapped, setUnmapped] = useState<StatusLite[]>(model.unmapped);
  const [deleting, setDeleting] = useState<BoardConfigColumn | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ type: 'status' | 'column'; label: string } | null>(
    null,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const boardId = model.boardId;

  // Restore a snapshot + toast — the shared failure path for every optimistic
  // write (mirrors BoardContainer.snapBack).
  const revert = useCallback(
    (snapCols: BoardConfigColumn[], snapUnmapped: StatusLite[], description: string) => {
      setColumns(snapCols);
      setUnmapped(snapUnmapped);
      toast({ variant: 'error', title: t('board.errorTitle'), description });
    },
    [t, toast],
  );

  // ── Status map / unmap (the 3.6.2 mapping endpoints) ──
  const mapStatus = useCallback(
    (statusId: string, toColumnId: string) => {
      const snapCols = columns;
      const snapUnmapped = unmapped;
      const status =
        snapUnmapped.find((s) => s.id === statusId) ??
        snapCols.flatMap((c) => c.statuses).find((s) => s.id === statusId);
      const next = mapStatusOptimistic(snapCols, snapUnmapped, statusId, toColumnId);
      setColumns(next.columns);
      setUnmapped(next.unmapped);
      void fetch(`/api/board/columns/${encodeURIComponent(toColumnId)}/statuses`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ boardId, statusId }),
      })
        .then((res) => {
          if (!res.ok) {
            revert(
              snapCols,
              snapUnmapped,
              t('board.toastMapError', { status: status?.label ?? '' }),
            );
          }
        })
        .catch(() =>
          revert(snapCols, snapUnmapped, t('board.toastMapError', { status: status?.label ?? '' })),
        );
    },
    [boardId, columns, unmapped, revert, t],
  );

  const unmapStatus = useCallback(
    (statusId: string, fromColumnId: string) => {
      const snapCols = columns;
      const snapUnmapped = unmapped;
      const status = snapCols.flatMap((c) => c.statuses).find((s) => s.id === statusId);
      const next = unmapStatusOptimistic(snapCols, snapUnmapped, statusId);
      setColumns(next.columns);
      setUnmapped(next.unmapped);
      const url =
        `/api/board/columns/${encodeURIComponent(fromColumnId)}/statuses/` +
        `${encodeURIComponent(statusId)}?boardId=${encodeURIComponent(boardId)}`;
      void fetch(url, { method: 'DELETE', headers: { accept: 'application/json' } })
        .then((res) => {
          if (!res.ok) {
            revert(
              snapCols,
              snapUnmapped,
              t('board.toastUnmapError', { status: status?.label ?? '' }),
            );
          }
        })
        .catch(() =>
          revert(
            snapCols,
            snapUnmapped,
            t('board.toastUnmapError', { status: status?.label ?? '' }),
          ),
        );
    },
    [boardId, columns, unmapped, revert, t],
  );

  // ── Column add / rename / reorder / delete (the 3.6.2 column endpoints) ──
  const addColumn = useCallback(
    (name: string) => {
      const snapCols = columns;
      const tempId = `temp-${name}-${snapCols.length}-${snapCols.reduce((n, c) => n + c.name.length, 0)}`;
      const position = keyBetween(snapCols[snapCols.length - 1]?.position ?? null, null);
      setColumns([...snapCols, { id: tempId, name, position, statuses: [], cardCount: 0 }]);
      void fetch('/api/board/columns', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ boardId, name, position }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`add ${res.status}`);
          const dto = (await res.json()) as { id: string; name: string; position: string };
          // Reconcile the temp id with the server's real column id.
          setColumns((prev) =>
            prev.map((c) =>
              c.id === tempId ? { ...c, id: dto.id, name: dto.name, position: dto.position } : c,
            ),
          );
        })
        .catch(() => revert(snapCols, unmapped, t('board.toastAddColumnError')));
    },
    [boardId, columns, unmapped, revert, t],
  );

  const renameColumn = useCallback(
    (columnId: string, name: string) => {
      const snapCols = columns;
      setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, name } : c)));
      void fetch(`/api/board/columns/${encodeURIComponent(columnId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name }),
      })
        .then((res) => {
          if (!res.ok) revert(snapCols, unmapped, t('board.toastRenameColumnError'));
        })
        .catch(() => revert(snapCols, unmapped, t('board.toastRenameColumnError')));
    },
    [columns, unmapped, revert, t],
  );

  const reorderColumn = useCallback(
    (activeId: string, overId: string) => {
      const snapCols = columns;
      const result = computeColumnReorder(snapCols, activeId, overId);
      if (!result) return;
      setColumns(result.columns);
      void fetch(`/api/board/columns/${encodeURIComponent(activeId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ position: result.position }),
      })
        .then((res) => {
          if (!res.ok) revert(snapCols, unmapped, t('board.toastReorderColumnError'));
        })
        .catch(() => revert(snapCols, unmapped, t('board.toastReorderColumnError')));
    },
    [columns, unmapped, revert, t],
  );

  const confirmDeleteColumn = useCallback(
    (column: BoardConfigColumn) => {
      const snapCols = columns;
      const snapUnmapped = unmapped;
      // Optimistic: drop the column, its statuses return to the rail.
      setColumns((prev) => prev.filter((c) => c.id !== column.id));
      setUnmapped((prev) => [...prev, ...column.statuses]);
      setDeleting(null);
      void fetch(`/api/board/columns/${encodeURIComponent(column.id)}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      })
        .then(async (res) => {
          if (res.ok) return;
          let code: string | undefined;
          try {
            code = ((await res.json()) as { code?: string }).code;
          } catch {
            code = undefined;
          }
          const description =
            code === 'LAST_COLUMN'
              ? t('board.toastLastColumnError')
              : code === 'COLUMN_NOT_EMPTY'
                ? t('board.toastColumnNotEmptyError', { name: column.name })
                : t('board.toastDeleteColumnError');
          revert(snapCols, snapUnmapped, description);
        })
        .catch(() => revert(snapCols, snapUnmapped, t('board.toastDeleteColumnError')));
    },
    [columns, unmapped, revert, t],
  );

  // ── dnd-kit handlers ──
  const handleDragStart = useCallback((e: DragStartEvent) => {
    const data = e.active.data.current as
      | { type?: 'status' | 'column'; label?: string }
      | undefined;
    if (data?.type) setActiveDrag({ type: data.type, label: data.label ?? '' });
  }, []);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveDrag(null);
      const { active, over } = e;
      if (!over) return;
      const data = active.data.current as
        | { type?: 'status' | 'column'; columnId?: string }
        | undefined;
      const activeId = String(active.id);
      const overId = String(over.id);

      if (data?.type === 'column') {
        if (overId === RAIL_DROP_ID) return; // a column can't drop onto the rail
        reorderColumn(activeId, overId);
        return;
      }
      if (data?.type === 'status') {
        const statusId = activeId; // active.id is the status id
        const fromColumnId = data.columnId ?? null;
        if (overId === RAIL_DROP_ID) {
          if (fromColumnId) unmapStatus(statusId, fromColumnId);
          return;
        }
        // over a column (its sortable/droppable id is the column id)
        if (overId !== fromColumnId && columns.some((c) => c.id === overId)) {
          mapStatus(statusId, overId);
        }
      }
    },
    [columns, reorderColumn, mapStatus, unmapStatus],
  );

  // ── Read-only (non-admin) treatment ──
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <div className="bg-(--el-surface) border-(--el-border) flex items-center gap-2.5 rounded-(--radius-card) border px-(--spacing-card-padding) py-3 text-sm text-(--el-text-secondary)">
          <Lock className="text-(--el-text-muted) size-[17px] shrink-0" aria-hidden />
          {t('board.readOnlyBanner')}
        </div>
        <BoardNameField boardId={boardId} initialName={model.boardName} readOnly />
        <ColumnsRow>
          {columns.map((column) => (
            <ReadOnlyColumn key={column.id} column={column} />
          ))}
        </ColumnsRow>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="flex flex-col gap-6">
        <BoardNameField boardId={boardId} initialName={model.boardName} />

        <UnmappedRail statuses={unmapped} />

        <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
          <ColumnsRow>
            {columns.map((column) => (
              <SortableColumn
                key={column.id}
                column={column}
                unmapped={unmapped}
                onRename={renameColumn}
                onDelete={(c) => setDeleting(c)}
                onMapStatus={mapStatus}
                onUnmapStatus={unmapStatus}
              />
            ))}
            <AddColumnGhost onAdd={addColumn} />
          </ColumnsRow>
        </SortableContext>
      </div>

      <DragOverlay>
        {activeDrag ? (
          <span className="bg-(--el-page-bg) border-(--el-accent) text-(--el-text-secondary) shadow-(--shadow-elevated) inline-flex items-center gap-1.5 rounded-(--radius-badge) border px-2 py-0.5 text-[12.5px] font-medium">
            {activeDrag.type === 'status' ? (
              <GripVertical className="text-(--el-text-faint) size-3" aria-hidden />
            ) : null}
            {activeDrag.label}
          </span>
        ) : null}
      </DragOverlay>

      {deleting ? (
        <DeleteColumnModal
          column={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => confirmDeleteColumn(deleting)}
        />
      ) : null}
    </DndContext>
  );
}

// ── Board name field — auto-save Input with a Saving…/Saved reconcile chip ────

function BoardNameField({
  boardId,
  initialName,
  readOnly = false,
}: {
  boardId: string;
  initialName: string;
  readOnly?: boolean;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const fieldId = useId();
  const [value, setValue] = useState(initialName);
  const committedRef = useRef(initialName);
  const [save, setSave] = useState<SaveState>('idle');

  const commit = useCallback(() => {
    const name = value.trim();
    if (!name || name === committedRef.current) {
      setValue(committedRef.current);
      return;
    }
    const prev = committedRef.current;
    committedRef.current = name;
    setValue(name);
    setSave('saving');
    void fetch('/api/board', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ boardId, name }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`rename ${res.status}`);
        setSave('saved');
      })
      .catch(() => {
        committedRef.current = prev;
        setValue(prev);
        setSave('idle');
        toast({
          variant: 'error',
          title: t('board.errorTitle'),
          description: t('board.toastRenameBoardError'),
        });
      });
  }, [boardId, value, t, toast]);

  return (
    <div className="bg-(--el-page-bg) border-(--el-border) shadow-(--shadow-subtle) flex flex-col rounded-(--radius-card) border p-(--spacing-card-padding)">
      <label htmlFor={fieldId} className="mb-1.5 text-sm font-semibold text-(--el-text-strong)">
        {t('board.boardNameLabel')}
      </label>
      <div className="flex items-end gap-3">
        <div className="max-w-[22rem] flex-1">
          <Input
            id={fieldId}
            value={value}
            disabled={readOnly}
            onChange={(e) => {
              setValue(e.target.value);
              if (save === 'saved') setSave('idle');
            }}
            onBlur={readOnly ? undefined : commit}
            onKeyDown={
              readOnly
                ? undefined
                : (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }
            }
          />
        </div>
        {save === 'saving' ? (
          <span
            className="flex items-center gap-1.5 pb-2 text-[12.5px] text-(--el-text-muted)"
            aria-live="polite"
          >
            <Spinner size="sm" aria-hidden />
            {t('board.saving')}
          </span>
        ) : save === 'saved' ? (
          <span
            className="flex items-center gap-1.5 pb-2 text-[12.5px] text-(--el-success)"
            aria-live="polite"
            data-testid="board-name-saved"
          >
            <Check className="size-3.5" aria-hidden />
            {t('board.saved')}
          </span>
        ) : null}
      </div>
      {!readOnly ? (
        <p className="mt-1.5 text-xs text-(--el-text-muted)">{t('board.boardNameHint')}</p>
      ) : null}
    </div>
  );
}

// ── Columns row layout ────────────────────────────────────────────────────────

function ColumnsRow({ children }: { children: React.ReactNode }) {
  const t = useTranslations('settings');
  return (
    <div
      className="flex items-start gap-3.5 overflow-x-auto pb-2"
      role="list"
      aria-label={t('board.columnsLabel')}
      data-testid="board-config-columns"
    >
      {children}
    </div>
  );
}

// ── Unmapped-statuses rail — interactive drop source + drop target ────────────

const RAIL_DROP_ID = '__board_config_unmapped__';

function UnmappedRail({ statuses }: { statuses: StatusLite[] }) {
  const t = useTranslations('settings');
  const { setNodeRef, isOver } = useDroppable({ id: RAIL_DROP_ID, data: { type: 'rail' } });
  const empty = statuses.length === 0;
  return (
    <section
      className="border-(--el-border) overflow-hidden rounded-(--radius-card) border"
      aria-label={t('board.unmappedTitle')}
      data-testid="board-config-unmapped"
    >
      <div className="bg-(--el-surface-soft) border-(--el-border) flex items-center gap-2 border-b px-4 py-3">
        {empty ? (
          <CircleCheck className="text-(--el-success) size-[17px] shrink-0" aria-hidden />
        ) : (
          <AlertTriangle className="text-(--el-warning) size-[17px] shrink-0" aria-hidden />
        )}
        <span className="text-sm font-semibold text-(--el-text-strong)">
          {t('board.unmappedTitle')}
        </span>
        {!empty ? (
          <span className="bg-(--el-tint-yellow) text-(--el-text-strong) inline-flex h-[18px] min-w-5 items-center justify-center rounded-(--radius-badge) px-1.5 text-[11px] font-bold">
            {statuses.length}
          </span>
        ) : null}
        <span className="flex-1" />
        {!empty ? (
          <span className="hidden text-xs text-(--el-text-muted) sm:inline">
            {t('board.unmappedHint')}
          </span>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-14 flex-wrap content-start gap-2 px-4 py-3.5 ${
          isOver
            ? 'bg-(--el-tint-lavender) outline-2 -outline-offset-[6px] outline-dashed outline-(--el-accent)'
            : ''
        }`}
      >
        {empty ? (
          <span className="flex items-center gap-2 text-sm text-(--el-text-muted)">
            <CircleCheck className="text-(--el-success) size-4" aria-hidden />
            {t('board.unmappedEmpty')}
          </span>
        ) : (
          statuses.map((status) => (
            <DraggableStatusChip key={status.id} status={status} fromColumnId={null} />
          ))
        )}
      </div>
    </section>
  );
}

// ── Draggable status chip (rail variant — no remove button) ──────────────────

function DraggableStatusChip({
  status,
  fromColumnId,
}: {
  status: StatusLite;
  fromColumnId: string | null;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: status.id,
    data: { type: 'status', columnId: fromColumnId, label: status.label },
  });
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid={`board-config-rail-chip-${status.id}`}
      className={`border-(--el-border) bg-(--el-page-bg) text-(--el-text-secondary) inline-flex cursor-grab items-center gap-1.5 rounded-(--radius-badge) border py-0.5 pr-2.5 pl-1 text-[12.5px] font-medium ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <GripVertical className="text-(--el-text-faint) size-3.5" aria-hidden />
      {status.label}
    </span>
  );
}

// ── Sortable column (admin) ──────────────────────────────────────────────────

function SortableColumn({
  column,
  unmapped,
  onRename,
  onDelete,
  onMapStatus,
  onUnmapStatus,
}: {
  column: BoardConfigColumn;
  unmapped: StatusLite[];
  onRename: (columnId: string, name: string) => void;
  onDelete: (column: BoardConfigColumn) => void;
  onMapStatus: (statusId: string, toColumnId: string) => void;
  onUnmapStatus: (statusId: string, fromColumnId: string) => void;
}) {
  const t = useTranslations('settings');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: column.id, data: { type: 'column', label: column.name } });
  const [renaming, setRenaming] = useState(false);

  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <section
      ref={setNodeRef}
      style={style}
      role="listitem"
      aria-label={t('board.columnLabel', { name: column.name, count: column.statuses.length })}
      data-testid={`board-config-column-${column.id}`}
      className={`bg-(--el-surface) border-(--el-border) flex w-[17rem] shrink-0 flex-col rounded-(--radius-card) border ${
        isDragging ? 'opacity-60' : ''
      } ${isOver ? 'outline-2 -outline-offset-1 outline-(--el-accent)' : ''}`}
    >
      <div className="border-(--el-border) flex items-center gap-1.5 border-b py-2.5 pr-2 pl-1.5">
        {renaming ? (
          <ColumnRenameField
            initial={column.name}
            onSave={(name) => {
              onRename(column.id, name);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={t('board.reorderColumnAria', { name: column.name })}
              data-testid={`board-config-column-grip-${column.id}`}
              className="text-(--el-text-faint) hover:text-(--el-text-muted) inline-flex size-4 shrink-0 cursor-grab items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <GripVertical className="size-4" aria-hidden />
            </button>
            <span className="flex-1 truncate text-sm font-semibold text-(--el-text-strong)">
              {column.name}
            </span>
            <span
              title={t('board.columnCountTitle', { count: column.statuses.length })}
              className="bg-(--el-muted) text-(--el-text-secondary) inline-flex h-[18px] min-w-5 items-center justify-center rounded-(--radius-badge) px-1.5 text-[11px] font-semibold"
            >
              {column.statuses.length}
            </span>
            <IconButton
              label={t('board.renameColumnAria', { name: column.name })}
              testId={`board-config-rename-${column.id}`}
              onClick={() => setRenaming(true)}
            >
              <Pencil className="size-[15px]" aria-hidden />
            </IconButton>
            <IconButton
              label={t('board.deleteColumnAria', { name: column.name })}
              testId={`board-config-delete-${column.id}`}
              danger
              onClick={() => onDelete(column)}
            >
              <Trash2 className="size-[15px]" aria-hidden />
            </IconButton>
          </>
        )}
      </div>

      <ColumnBody column={column} onUnmapStatus={onUnmapStatus}>
        <AddStatusMenu column={column} unmapped={unmapped} onMapStatus={onMapStatus} />
      </ColumnBody>
    </section>
  );
}

// The column body is itself a droppable so a status dropped anywhere inside the
// column (not just on its header) maps there. (Its droppable id is the column
// id, the same id the sortable registers — one target.)
function ColumnBody({
  column,
  children,
  onUnmapStatus,
}: {
  column: BoardConfigColumn;
  children: React.ReactNode;
  onUnmapStatus: (statusId: string, fromColumnId: string) => void;
}) {
  const t = useTranslations('settings');
  return (
    <div className="flex flex-1 flex-col gap-2 px-2.5 py-3">
      {column.statuses.length === 0 ? (
        <p className="border-(--el-border) rounded-(--radius-control) border border-dashed px-2.5 py-4 text-center text-xs text-(--el-text-muted)">
          {t('board.columnEmpty')}
        </p>
      ) : (
        column.statuses.map((status) => (
          <MappedStatusChip
            key={status.id}
            status={status}
            columnId={column.id}
            onRemove={() => onUnmapStatus(status.id, column.id)}
          />
        ))
      )}
      {children}
    </div>
  );
}

// ── Mapped status chip (full-width row inside a column, grip + label + ×) ─────

function MappedStatusChip({
  status,
  columnId,
  onRemove,
}: {
  status: StatusLite;
  columnId: string;
  onRemove: () => void;
}) {
  const t = useTranslations('settings');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: status.id,
    data: { type: 'status', columnId, label: status.label },
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`board-config-chip-${status.id}`}
      className={`border-(--el-border) bg-(--el-page-bg) flex items-center gap-1.5 rounded-(--radius-badge) border py-0.5 pr-1 pl-1 text-[12.5px] font-medium text-(--el-text-secondary) ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('board.statusGripAria', { status: status.label })}
        className="text-(--el-text-faint) inline-flex size-3.5 shrink-0 cursor-grab items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <span className="flex-1 truncate">{status.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('board.removeStatusAria', { status: status.label })}
        data-testid={`board-config-unmap-${status.id}`}
        className="text-(--el-text-faint) hover:bg-(--el-muted) hover:text-(--el-danger) inline-flex size-[18px] shrink-0 items-center justify-center rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

// ── Per-column "Add status" picker menu (the non-drag KEYBOARD path, #35) ─────

function AddStatusMenu({
  column,
  unmapped,
  onMapStatus,
}: {
  column: BoardConfigColumn;
  unmapped: StatusLite[];
  onMapStatus: (statusId: string, toColumnId: string) => void;
}) {
  const t = useTranslations('settings');
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid={`board-config-add-status-${column.id}`}
        className="border-(--el-border-strong) text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) inline-flex w-full items-center justify-center gap-1.5 rounded-(--radius-control) border border-dashed px-(--spacing-control-x) py-(--spacing-control-y) text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Plus className="size-3.5" aria-hidden />
        {t('board.addStatus')}
      </Popover.Trigger>
      <Popover.Content
        width={236}
        align="start"
        className="p-0"
        aria-label={t('board.addStatusMenuAria', { name: column.name })}
      >
        <div className="flex flex-col gap-0.5 p-1.5" role="menu">
          <span className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {t('board.addStatusMenuCap')}
          </span>
          {unmapped.length === 0 ? (
            <p className="px-2 py-2.5 text-center text-[12.5px] text-(--el-text-muted)">
              {t('board.addStatusMenuEmpty')}
            </p>
          ) : (
            unmapped.map((status) => (
              <button
                key={status.id}
                type="button"
                role="menuitem"
                data-testid={`board-config-pick-${status.id}`}
                onClick={() => {
                  onMapStatus(status.id, column.id);
                  setOpen(false);
                }}
                className="hover:bg-(--el-muted) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) focus-visible:bg-(--el-muted) focus-visible:outline-none"
              >
                <span
                  className="bg-(--el-border-strong) size-2 shrink-0 rounded-full"
                  aria-hidden
                />
                <span className="flex-1 truncate">{status.label}</span>
              </button>
            ))
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}

// ── Inline column rename field ────────────────────────────────────────────────

function ColumnRenameField({
  initial,
  onSave,
  onCancel,
  placeholder,
  ariaLabel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const t = useTranslations('settings');
  const [value, setValue] = useState(initial);
  const commit = () => {
    const name = value.trim();
    if (name) onSave(name);
    else onCancel();
  };
  return (
    <span className="flex flex-1 items-center gap-1">
      <input
        type="text"
        autoFocus
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? t('board.columnNameAria')}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="border-(--el-accent) bg-(--el-page-bg) h-[30px] min-w-0 flex-1 rounded-(--radius-input) border px-2 text-[13px] font-semibold text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      />
      <IconButton label={t('board.saveColumnNameAria')} onClick={commit}>
        <Check className="size-[15px]" aria-hidden />
      </IconButton>
      <IconButton label={t('board.cancelRenameAria')} onClick={onCancel}>
        <X className="size-[15px]" aria-hidden />
      </IconButton>
    </span>
  );
}

// ── Trailing "Add column" ghost column ────────────────────────────────────────

function AddColumnGhost({ onAdd }: { onAdd: (name: string) => void }) {
  const t = useTranslations('settings');
  const [adding, setAdding] = useState(false);
  if (adding) {
    return (
      <section className="bg-(--el-surface) border-(--el-border) flex w-[17rem] shrink-0 flex-col rounded-(--radius-card) border">
        <div className="border-(--el-border) flex items-center gap-1.5 border-b py-2.5 pr-2 pl-1.5">
          <ColumnRenameField
            initial=""
            placeholder={t('board.columnNamePlaceholder')}
            ariaLabel={t('board.newColumnNameAria')}
            onSave={(name) => {
              onAdd(name);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
        <div className="px-2.5 py-3">
          <p className="border-(--el-border) rounded-(--radius-control) border border-dashed px-2.5 py-4 text-center text-xs text-(--el-text-muted)">
            {t('board.columnEmpty')}
          </p>
        </div>
      </section>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      data-testid="board-config-add-column"
      className="border-(--el-border-strong) text-(--el-text-secondary) hover:bg-(--el-muted) flex min-h-60 w-[17rem] shrink-0 flex-col items-center justify-center gap-2 rounded-(--radius-card) border border-dashed text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <span className="bg-(--el-muted) text-(--el-text-muted) inline-flex size-7 items-center justify-center rounded-full">
        <Plus className="size-4" aria-hidden />
      </span>
      {t('board.addColumn')}
    </button>
  );
}

// ── Read-only column (non-admin) ─────────────────────────────────────────────

function ReadOnlyColumn({ column }: { column: BoardConfigColumn }) {
  const t = useTranslations('settings');
  return (
    <section
      role="listitem"
      aria-label={t('board.columnLabel', { name: column.name, count: column.statuses.length })}
      data-testid={`board-config-column-${column.id}`}
      className="bg-(--el-surface) border-(--el-border) flex w-[17rem] shrink-0 flex-col rounded-(--radius-card) border"
    >
      <div className="border-(--el-border) flex items-center gap-1.5 border-b px-3 py-2.5">
        <span className="flex-1 truncate text-sm font-semibold text-(--el-text-strong)">
          {column.name}
        </span>
        <span className="bg-(--el-muted) text-(--el-text-secondary) inline-flex h-[18px] min-w-5 items-center justify-center rounded-(--radius-badge) px-1.5 text-[11px] font-semibold">
          {column.statuses.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col items-start gap-2 px-2.5 py-3">
        {column.statuses.map((status) => (
          <Pill key={status.id} tone="neutral">
            {status.label}
          </Pill>
        ))}
      </div>
    </section>
  );
}

// ── Delete-column confirm (normal + the Jira-style guard) ─────────────────────

function DeleteColumnModal({
  column,
  onCancel,
  onConfirm,
}: {
  column: BoardConfigColumn;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  // The guard (panel 4b): a mapped status still holds work items on the board.
  // Pre-empt the 3.6.2 `ColumnNotEmptyError` (409) by checking the column's full
  // card count from the projection — refuse the delete and point the admin to
  // remap first. An empty (or status-less) column deletes cleanly (panel 4a).
  const blocked = column.cardCount > 0 && column.statuses.length > 0;
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm">
      {blocked ? (
        <>
          <h2 className="flex items-center gap-2.5 font-serif text-lg font-semibold text-(--el-text-strong)">
            <AlertTriangle className="text-(--el-warning) size-5 shrink-0" aria-hidden />
            {t('board.guardTitle', { name: column.name })}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
            {t('board.guardBody', { count: column.cardCount })}
          </p>
          <div className="bg-(--el-tint-peach) mt-3 flex items-start gap-2 rounded-(--radius-control) px-3 py-2.5 text-[12.5px] text-(--el-text-strong)">
            <AlertTriangle className="text-(--el-warning) mt-px size-4 shrink-0" aria-hidden />
            <span>
              {t('board.guardStillHolding')}{' '}
              <span className="inline-flex flex-wrap gap-1.5 align-middle">
                {column.statuses.map((s) => (
                  <Pill key={s.id} tone="neutral">
                    {s.label}
                  </Pill>
                ))}
              </span>
            </span>
          </div>
          <Modal.Footer>
            <Button variant="primary" onClick={onCancel}>
              {t('board.guardAcknowledge')}
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <>
          <h2 className="flex items-center gap-2.5 font-serif text-lg font-semibold text-(--el-text-strong)">
            <Trash2 className="text-(--el-danger) size-5 shrink-0" aria-hidden />
            {t('board.deleteTitle', { name: column.name })}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
            {t('board.deleteBody')}
          </p>
          <div className="bg-(--el-surface) mt-3 flex items-start gap-2 rounded-(--radius-control) px-3 py-2.5 text-[12.5px] text-(--el-text-secondary)">
            {column.statuses.length > 0 ? (
              <span>
                {t('board.deleteReturns')}{' '}
                <span className="inline-flex flex-wrap gap-1.5 align-middle">
                  {column.statuses.map((s) => (
                    <Pill key={s.id} tone="neutral">
                      {s.label}
                    </Pill>
                  ))}
                </span>
              </span>
            ) : (
              <span>{t('board.deleteNoStatuses')}</span>
            )}
          </div>
          <Modal.Footer>
            <Button variant="ghost" onClick={onCancel}>
              {tc('cancel')}
            </Button>
            <Button
              variant="danger"
              leftIcon={<Trash2 className="size-4" />}
              onClick={onConfirm}
              data-testid="board-config-delete-confirm"
            >
              {t('board.deleteConfirm')}
            </Button>
          </Modal.Footer>
        </>
      )}
    </Modal>
  );
}

// ── Small icon button (matches the design's header affordances) ──────────────

function IconButton({
  label,
  onClick,
  danger = false,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className={`text-(--el-text-muted) hover:bg-(--el-muted) inline-flex size-[26px] shrink-0 items-center justify-center rounded-(--radius-control) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        danger ? 'hover:text-(--el-danger)' : ''
      }`}
    >
      {children}
    </button>
  );
}
