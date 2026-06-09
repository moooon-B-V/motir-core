'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { GripVertical, MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Avatar, StatusValue } from '../../issues/_components/issueCellPrimitives';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { useBacklogDnd } from './BacklogDndProvider';
import type { StatusByKey } from './backlogShared';

// One backlog / sprint issue row (Story 4.2 · render 4.2.3 · drag 4.2.4). Reuses
// the Story-2.x work-items list-row vocabulary — the `IssueTypeIcon` in its
// `--el-type-*` hue, the mono key, the truncating summary, the assignee avatar,
// the status `Pill` (via `StatusValue`) — and renders IDENTICALLY in the backlog
// and inside sprint containers (one global `backlogRank`).
//
// Slot order (design/backlog/backlog.mock.html panel 2): grip · type icon · key ·
// summary · estimate SEAM · assignee · status · ⋯. The reserved **estimate seam**
// (a labelled `--el-text-faint` em-dash) holds the place Story 4.3 drops the
// inline estimate badge into — so 4.3 needs no relayout (4.2.1 design notes).
//
// DRAG (Subtask 4.2.4): the WHOLE row is the dnd-kit drag handle (the grip is the
// hover cue, design panel 3) — `BacklogSortableRow` makes the row a `useSortable`
// draggable; while lifted, the resting row becomes a dashed 40%-opacity GHOST
// marking the slot and the lifted clone is the `DragOverlay`'s `BacklogRowOverlay`.
// SELECTION (the row checkbox) + the `⋯` menu actions are Subtask 4.2.5 (the `⋯`
// button is PLACED disabled here). The EPIC chip the design draws needs the epic
// key/title the bound `WorkItemSummaryDto` does not carry — see PRODECT_FINDINGS.

const EM_DASH = '—';

// The presentational row body — shared by the in-list sortable row AND the
// `DragOverlay` clone, so the lifted row looks identical to its resting form.
// `dragProps`/`innerRef`/`style` are the dnd-kit handle wiring (absent on the
// overlay); `dragging` swaps in the dashed ghost; `dropBefore` shows the
// insertion bar above the row when it is the hovered drop target.
function BacklogRowBody({
  item,
  statusByKey,
  assigneeNameById,
  innerRef,
  style,
  dragProps,
  dragging = false,
  dropBefore = false,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  innerRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  dragProps?: Record<string, unknown>;
  dragging?: boolean;
  dropBefore?: boolean;
}): ReactNode {
  const t = useTranslations('backlog');
  const status = statusByKey.get(item.status);
  const assigneeName = item.assigneeId ? (assigneeNameById.get(item.assigneeId) ?? null) : null;

  return (
    <div
      ref={innerRef}
      style={style}
      // Spread the dnd-kit attributes/listeners FIRST, then re-assert role="row"
      // so the sortable's role=button doesn't override the design's row semantics
      // (the row stays a labelled row; aria-roledescription="sortable" + the
      // keyboard handlers survive). The whole row is the drag handle (design
      // panel 3); `touch-none` keeps a touch-drag from scrolling the list.
      {...dragProps}
      role="row"
      data-testid={`backlog-row-${item.identifier}`}
      data-dragging={dragging ? 'true' : undefined}
      className={`group relative flex touch-none items-center gap-2 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y) ${
        dragProps ? 'cursor-grab' : ''
      } ${
        dragging
          ? 'border-dashed border-(--el-border-strong) opacity-40'
          : 'border-transparent hover:border-(--el-border-soft) hover:bg-(--el-surface-soft)'
      }`}
    >
      {/* Insertion bar — a 3px accent pill marking the drop slot above this row. */}
      {dropBefore ? (
        <span
          aria-hidden
          className="absolute -top-[2px] right-1 left-1 h-[3px] rounded-full bg-(--el-accent)"
        />
      ) : null}
      {/* Drag affordance cue — the whole row is the handle (the grip is the hint). */}
      <GripVertical
        className="h-4 w-4 shrink-0 text-(--el-text-faint) opacity-0 group-hover:opacity-100"
        aria-hidden
      />
      <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4 shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">{item.title}</span>
      {/* Reserved estimate seam (→ Story 4.3) — labelled, not a number yet. */}
      <span
        className="shrink-0 text-xs text-(--el-text-faint)"
        title={t('estimateSeam')}
        aria-label={t('estimateSeam')}
      >
        {EM_DASH}
      </span>
      {assigneeName ? (
        <span className="shrink-0" title={assigneeName}>
          <Avatar name={assigneeName} />
        </span>
      ) : (
        <span
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) text-[10px] text-(--el-text-faint)"
          title={t('unassigned')}
          aria-label={t('unassigned')}
        >
          {EM_DASH}
        </span>
      )}
      <span className="shrink-0">
        {status ? (
          <StatusValue category={status.category} label={status.label} />
        ) : (
          <StatusValue category={null} label={item.status} />
        )}
      </span>
      {/* `⋯` row menu — PLACED; its actions are wired in Subtask 4.2.5. */}
      <button
        type="button"
        disabled
        aria-label={t('rowActions')}
        title={t('rowActionsComingSoon')}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) disabled:opacity-40"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

// The draggable in-list row (Subtask 4.2.4) — a `useSortable` item whose whole
// surface is the drag handle. Reads the coordinator's `overRowId` to show the
// insertion bar when this row is the hovered drop slot.
export function BacklogSortableRow({
  item,
  statusByKey,
  assigneeNameById,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
}) {
  const { overRowId, activeId } = useBacklogDnd();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  return (
    <BacklogRowBody
      item={item}
      statusByKey={statusByKey}
      assigneeNameById={assigneeNameById}
      innerRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragProps={{ ...attributes, ...listeners }}
      dragging={isDragging}
      dropBefore={overRowId === item.id && activeId !== item.id}
    />
  );
}

// The lifted clone the `DragOverlay` renders following the cursor (design panel
// 3): tilted ~2°, raised to `--shadow-elevated`, accent border — visually
// distinct from both the resting row and its dashed ghost.
export function BacklogRowOverlay({
  item,
  statusByKey,
  assigneeNameById,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
}) {
  return (
    <div className="rotate-1 cursor-grabbing rounded-(--radius-control) border border-(--el-accent) bg-(--el-surface) shadow-(--shadow-elevated)">
      <BacklogRowBody item={item} statusByKey={statusByKey} assigneeNameById={assigneeNameById} />
    </div>
  );
}
