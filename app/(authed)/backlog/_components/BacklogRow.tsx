'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { Check, GripVertical, MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { Avatar, StatusValue } from '../../items/_components/issueCellPrimitives';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { useBacklogDnd } from './BacklogDndProvider';
import { RowActionsMenu } from './RowActionsMenu';
import type { RegionKind } from './backlogDnd';
import type { StatusByKey } from './backlogShared';

// One backlog / sprint issue row (Story 4.2 · render 4.2.3 · drag 4.2.4 ·
// grooming 4.2.5). Reuses the Story-2.x work-items list-row vocabulary — the
// `IssueTypeIcon` in its `--el-type-*` hue, the mono key, the truncating summary,
// the assignee avatar, the status `Pill` (via `StatusValue`) — and renders
// IDENTICALLY in the backlog and inside sprint containers (one global
// `backlogRank`).
//
// Slot order (design/backlog/backlog.mock.html panel 2): grip · checkbox · type
// icon · key · summary · estimate SEAM · assignee · status · ⋯. The estimate seam
// is FILLED (4.3.4) by the inline `EstimateBadge` in its fixed slot.
//
// DRAG (4.2.4): the WHOLE row is the dnd-kit drag handle (the grip is the hover
// cue); while lifted, the resting row is a dashed ghost and the clone is the
// `DragOverlay`'s `BacklogRowOverlay`.
// SELECTION + MENU (4.2.5): the **checkbox** toggles selection (keyed by id);
// **row click** selects (shift = range, ⌘/ctrl = toggle); the **`⋯` menu** moves
// the row to a sprint / the backlog / a backlog boundary. Selected rows carry the
// lavender tint AND the checked box (never colour-alone, finding #35). The
// checkbox + `⋯` are sibling controls that stop propagation so they neither drag
// nor row-select. The EPIC chip the design draws needs the epic key/title the
// bound `WorkItemSummaryDto` does not carry — see PRODECT_FINDINGS.

const EM_DASH = '—';

// The presentational row body — shared by the in-list sortable row AND the
// `DragOverlay` clone, so the lifted row looks identical to its resting form.
// `dragProps`/`innerRef`/`style` are the dnd-kit handle wiring (absent on the
// overlay); `dragging` swaps in the dashed ghost; `dropBefore` shows the
// insertion bar; `selected` adds the selection tint; `checkbox`/`actions` are the
// selection control + `⋯` menu (real on the row, static on the overlay).
function BacklogRowBody({
  item,
  statusByKey,
  assigneeNameById,
  innerRef,
  style,
  dragProps,
  dragging = false,
  dropBefore = false,
  selected = false,
  onRowClick,
  checkbox,
  actions,
  onEstimateChanged,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  innerRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  dragProps?: Record<string, unknown>;
  dragging?: boolean;
  dropBefore?: boolean;
  selected?: boolean;
  onRowClick?: (e: React.MouseEvent) => void;
  checkbox?: ReactNode;
  actions?: ReactNode;
  /** Fired after an inline point edit commits → the host re-fetches a derived
   *  roll-up (the sprint committed-points badge). Omitted on the drag overlay
   *  clone, which isn't an interactive edit surface (MOTIR-1495). */
  onEstimateChanged?: () => void;
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
      aria-selected={selected || undefined}
      onClick={onRowClick}
      data-testid={`backlog-row-${item.identifier}`}
      data-dragging={dragging ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={`group relative flex touch-none items-center gap-2 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y) select-none ${
        dragProps ? 'cursor-grab' : ''
      } ${
        dragging
          ? 'border-dashed border-(--el-border-strong) opacity-40'
          : selected
            ? 'border-(--el-accent) bg-(--el-selection-bg)'
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
      {checkbox}
      <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4 shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">{item.title}</span>
      {/* The estimate seam the 4.2 row reserved is FILLED (Subtask 4.3.4) by the
          inline `EstimateBadge` — same fixed slot, no relayout. A flex sibling of
          the avatar / status / ⋯ controls, never nested in them. */}
      <span className="shrink-0">
        <EstimateBadge
          itemId={item.id}
          storyPoints={item.storyPoints}
          estimateMinutes={item.estimateMinutes}
          onEstimateChanged={onEstimateChanged}
        />
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
      {actions}
    </div>
  );
}

// The selection checkbox (Subtask 4.2.5) — keyed by issue id (selection survives
// lazy-load / virtualized scroll). Checked → accent fill + check; a sibling
// control that stops propagation so a click neither starts a drag nor row-selects
// twice (the checkbox owns the toggle).
function SelectionCheckbox({
  selected,
  identifier,
  onToggle,
}: {
  selected: boolean;
  identifier: string;
  onToggle: () => void;
}) {
  const t = useTranslations('backlog');
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={
        selected ? t('deselectRow', { key: identifier }) : t('selectRow', { key: identifier })
      }
      data-testid={`backlog-row-check-${identifier}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) border focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
        selected
          ? 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
          : 'border-(--el-border-strong) bg-(--el-surface)'
      }`}
    >
      {selected ? <Check className="h-3 w-3" aria-hidden /> : null}
    </button>
  );
}

// The draggable in-list row (Subtask 4.2.4) — a `useSortable` item whose whole
// surface is the drag handle, now carrying the selection checkbox, the selected
// treatment, row-click selection, and the `⋯` menu (Subtask 4.2.5).
export function BacklogSortableRow({
  item,
  statusByKey,
  assigneeNameById,
  regionKind,
  sprintId,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Where this row lives — drives the `⋯` menu's context-dependent actions. */
  regionKind: RegionKind;
  /** The current sprint id (null in the backlog) — check-marked in the move submenu. */
  sprintId?: string;
}) {
  const { overRowId, activeId, selectedIds, activateRow, toggleRow, bumpSprintPoints } =
    useBacklogDnd();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const selected = selectedIds.has(item.id);

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
      selected={selected}
      // An in-sprint point edit changes the sprint's committed roll-up → refetch
      // its badge once the estimate commits (MOTIR-1495).
      onEstimateChanged={bumpSprintPoints}
      onRowClick={(e) =>
        activateRow(item.id, { shiftKey: e.shiftKey, toggleKey: e.metaKey || e.ctrlKey })
      }
      checkbox={
        <SelectionCheckbox
          selected={selected}
          identifier={item.identifier}
          onToggle={() => toggleRow(item.id)}
        />
      }
      actions={
        <RowActionsMenu
          itemId={item.id}
          identifier={item.identifier}
          regionKind={regionKind}
          currentSprintId={sprintId ?? null}
        />
      }
    />
  );
}

// The lifted clone the `DragOverlay` renders following the cursor (design panel
// 3): tilted ~2°, raised to `--shadow-elevated`, accent border — visually
// distinct from both the resting row and its dashed ghost. A multi-select drag
// (`count > 1`) stacks an accent **N** count badge (the bulk path it routes
// through). Its checkbox + `⋯` are static (non-interactive) mirrors of the row's.
export function BacklogRowOverlay({
  item,
  statusByKey,
  assigneeNameById,
  count = 1,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  count?: number;
}) {
  return (
    <div className="relative rotate-1 cursor-grabbing rounded-(--radius-control) border border-(--el-accent) bg-(--el-surface) shadow-(--shadow-elevated)">
      <BacklogRowBody
        item={item}
        statusByKey={statusByKey}
        assigneeNameById={assigneeNameById}
        selected={count > 1}
        checkbox={
          <span
            aria-hidden
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)"
          >
            <Check className="h-3 w-3" />
          </span>
        }
        actions={
          <span
            aria-hidden
            className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center text-(--el-text-muted)"
          >
            <MoreHorizontal className="h-4 w-4" />
          </span>
        }
      />
      {count > 1 ? (
        <span
          aria-hidden
          data-testid="backlog-drag-count"
          className="absolute -top-2 -right-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-(--el-accent) px-1 text-[11px] font-semibold text-(--el-accent-text) shadow-(--shadow-card)"
        >
          {count}
        </span>
      ) : null}
    </div>
  );
}
