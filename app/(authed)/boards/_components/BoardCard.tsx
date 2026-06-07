'use client';

import { useTranslations } from 'next-intl';
import { CircleAlert, GripVertical } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { formatDurationMinutes } from '@/lib/utils/duration';
import type { BoardCardDto } from '@/lib/dto/boards';
import { Avatar, PriorityValue } from '../../issues/_components/issueCellPrimitives';

// BoardCard (Subtask 3.2.3) — the compact issue card per
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
// surface, never a full-page navigation. The card is keyboard-focusable; it
// becomes the dnd-kit drag handle in 3.2.4 (the grip is the affordance cue,
// drawn here, wired there). Colour strictly `--el-*`, shape via element tokens.
//
// A board card carries only `assigneeId` on the `BoardCardDto` (Story 3.1.4), so
// the parent column resolves the id → display name from the workspace members
// the board page passes down, and hands the resolved `assigneeName` (or null) in.

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
  const estimate =
    card.estimateMinutes != null ? formatDurationMinutes(card.estimateMinutes) : null;

  return (
    <button
      type="button"
      onClick={() => onOpenQuickView(card.identifier)}
      aria-label={t('openIssueAria', { key: card.identifier, title: card.title })}
      data-testid={`board-card-${card.identifier}`}
      className="group flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) text-left shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <span className="flex items-center gap-1.5">
        <IssueTypeIcon type={card.kind} className="h-4 w-4 shrink-0" />
        <span className="font-mono text-xs text-(--el-text-muted)">{card.identifier}</span>
        <span className="flex-1" />
        {/* Drag affordance cue — the whole card becomes the drag handle in 3.2.4;
            here it is a decorative, hover-revealed hint only. */}
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
    </button>
  );
}
