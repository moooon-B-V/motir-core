'use client';

import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CircleAlert, GripVertical } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { formatDurationMinutes } from '@/lib/utils/duration';
import type { BoardCardDto } from '@/lib/dto/boards';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { Avatar, PriorityValue } from '../../issues/_components/issueCellPrimitives';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { useNotifyIssuesChanged } from '../../_components/CreateIssueProvider';

// BoardCard (Subtask 3.2.3 · drag wired in 3.2.4) — the compact issue card per
// `design/boards/board.mock.html` (`.bcard`). It REUSES the shipped issue
// primitives so a card renders IDENTICALLY to the same issue in the list (the
// reuse rule, notes.html #31 — no forked card vocabulary):
//   - `IssueTypeIcon` — the kind glyph in its `--el-type-*` hue (finding #54)
//   - `PriorityValue` / `PRIORITY_META` — the exact priority chip the issue list
//     renders (Pill tone + direction icon); the mock's 3-bucket colouring is
//     illustrative, PRIORITY_META is the single source of truth (decision ladder
//     rung 2 + the design-notes' "PRIORITY_META tone" instruction)
//   - `Avatar` — the initial-letter assignee avatar (unassigned → a dashed
//     placeholder, the one treatment the shipped Avatar doesn't cover)
//
// Clicking the card opens the EXISTING `IssueQuickView` peek (Story 2.5) via the
// `onOpenQuickView` handler the board page wired in 3.2.2 — never a new detail
// surface, never a full-page navigation.
//
// DRAG (3.2.4): the WHOLE card is the dnd-kit drag handle (the grip is the
// affordance cue, design panel 1). The card is a `useSortable` draggable:
//   - Pointer: a click (no movement) opens the quick view; a drag (the pointer
//     sensor's 8px activation distance) lifts the card instead — the two never
//     fire together.
//   - Keyboard: per 3.2.2, ENTER opens the quick view (native button activation)
//     while SPACE picks the card up for a keyboard drag (the keyboard sensor's
//     only start key — see BoardContainer). Escape cancels mid-drag.
// While lifted the in-place card becomes a dashed 40%-opacity GHOST marking the
// insertion slot (design panel 1, "source card leaves a dashed ghost"); the
// lifted clone is rendered by the board's `DragOverlay` (see BoardCardView).
//
// A board card carries only `assigneeId` on the `BoardCardDto` (Story 3.1.4), so
// the parent column resolves the id → display name from the workspace members
// the board page passes down, and hands the resolved `assigneeName` (or null) in.

// The presentational card body — shared by the in-list sortable card AND the
// `DragOverlay` clone, so the lifted card looks identical to its resting form.
export function BoardCardView({
  card,
  assigneeName,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
}) {
  const t = useTranslations('boards');
  const estimate =
    card.estimateMinutes != null ? formatDurationMinutes(card.estimateMinutes) : null;

  return (
    <>
      <span className="flex items-center gap-1.5">
        <IssueTypeIcon type={card.kind} className="h-4 w-4 shrink-0" />
        <span className="font-mono text-xs text-(--el-text-muted)">{card.identifier}</span>
        <span className="flex-1" />
        {/* Drag affordance cue — the whole card is the drag handle (3.2.4); the
            grip is the hover-revealed hint. */}
        <GripVertical
          className="h-4 w-4 shrink-0 text-(--el-text-faint) opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </span>

      <span className="line-clamp-2 text-[13.5px] leading-snug text-(--el-text) group-hover:underline">
        {card.title}
      </span>

      <span className="flex items-center gap-1.5">
        {/* Blocked cards swap the priority chip for a "Blocked" peach pill — the
            ReadinessBadge tone, driven by the finding-#21 `ready` flag. State is
            carried by text + icon, never colour alone (finding #35). */}
        {card.ready ? (
          <PriorityValue priority={card.priority} />
        ) : (
          <Pill severity="warning">
            <CircleAlert className="h-3 w-3" aria-hidden />
            {t('blocked')}
          </Pill>
        )}
        {estimate ? (
          <span
            className="font-mono text-xs font-semibold text-(--el-text-secondary)"
            title={t('estimateLabel', { value: estimate })}
          >
            {estimate}
          </span>
        ) : null}
        <span className="flex-1" />
        {assigneeName ? (
          <span title={t('assignedTo', { name: assigneeName })}>
            <Avatar name={assigneeName} />
          </span>
        ) : (
          <span
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted) text-[10px] font-semibold text-(--el-text-faint)"
            title={t('unassigned')}
            aria-label={t('unassigned')}
          >
            –
          </span>
        )}
      </span>
    </>
  );
}

const CARD_CLASS =
  'group flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) text-left shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function BoardCard({
  card,
  assigneeName,
  onOpenQuickView,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
  onOpenQuickView: (identifier: string) => void;
}) {
  const t = useTranslations('boards');
  const { canEdit, canManage } = useProjectAccess();
  const notifyIssuesChanged = useNotifyIssuesChanged();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  return (
    // `relative group/card` hosts the card button + the hover-revealed ⋯ menu
    // OVERLAY (2.8.4). The menu is a SIBLING of the draggable button, never a
    // child — nesting an interactive control inside the card button would be a
    // nested-interactive a11y violation and would steal the drag pointer.
    <div className="group/card relative">
      <button
        ref={setNodeRef}
        type="button"
        onClick={() => onOpenQuickView(card.identifier)}
        aria-label={t('openIssueAria', { key: card.identifier, title: card.title })}
        data-testid={`board-card-${card.identifier}`}
        // `data-tilt` opts the kanban card into the 3D / Immersive pointer-tilt
        // (7.3.39). Inert for every other style + under reduced motion. While
        // dragging, dnd-kit's inline `transform` (a translate) overrides the
        // tilt transform, so the two never fight; at rest the tilt applies.
        data-tilt=""
        // `data-surface` opts the board card into the surface-MATERIAL layer so a
        // surface-material style (glassmorphism frost, aurora glow) reaches the
        // board — not only Card-built settings surfaces. Inert under non-material
        // styles (no `[data-style] [data-surface]` rule targets them). 7.3.38.
        data-surface="card"
        style={{ transform: CSS.Translate.toString(transform), transition }}
        // While lifted, the resting card is the dashed ghost marking the insertion
        // slot (the DragOverlay carries the visible clone); `touch-none` keeps a
        // touch-drag from scrolling the column. `cursor-grab` is the affordance.
        className={`${CARD_CLASS} w-full cursor-grab touch-none ${
          isDragging ? 'border-dashed opacity-40' : ''
        }`}
        {...attributes}
        {...listeners}
      >
        <BoardCardView card={card} assigneeName={assigneeName} />
      </button>
      {/* Hidden until the card is hovered / the menu is focused — and
        `pointer-events-none` while hidden so it never intercepts a click/drag
        meant for the card corner. */}
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-events-none">
        <WorkItemActionsMenu
          itemId={card.id}
          identifier={card.identifier}
          title={card.title}
          canEdit={canEdit}
          canManage={canManage}
          onDeleted={notifyIssuesChanged}
          onArchived={notifyIssuesChanged}
          triggerClassName="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) text-(--el-text-muted) shadow-(--shadow-subtle) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        />
      </div>
    </div>
  );
}

// The lifted clone the board's `DragOverlay` renders following the cursor (design
// panel 1): tilted ~2.5°, raised to `--shadow-elevated`, accent border, grabbing
// cursor — visually distinct from both the resting card and its dashed ghost.
// Fixed-width (the column's content width) since it lives outside any column.
export function BoardCardOverlay({
  card,
  assigneeName,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
}) {
  return (
    <div
      data-surface="card"
      className={`${CARD_CLASS} w-[17rem] rotate-2 cursor-grabbing border-(--el-accent) shadow-(--shadow-elevated)`}
    >
      <BoardCardView card={card} assigneeName={assigneeName} />
    </div>
  );
}
