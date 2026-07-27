'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

// The TARGET chip — one picked work item in the planning composer's target tray,
// and (compact) in the turn it was sent with (Subtask MOTIR-1491; design
// `target-picker.mock.html` panels 2 + 3).
//
// ⚠️ It is the SHIPPED work-item-reference chip's grammar (5.8 / MOTIR-1399 —
// `WorkItemRefChip`'s `.wi-chip`: type-hue icon · mono key · title), re-expressed
// for this context rather than re-styled: the shipped rule set lives in
// `markdown-editor.css` scoped to `.motir-prose` and describes a NAVIGATING link
// (hover underline, peek on click). A target is neither — it is a token you
// REMOVE, sitting in a chat composer that is not prose. So the same token roles
// are used (`--el-surface-soft` fill, `--el-border`, `--radius-control`, the
// small-chip kbd padding pair, the mono key in `--el-link`) with the interaction
// the tray needs. No status dot: a target assignment doesn't imply status
// relevance (the design says so explicitly).

export interface PlanningTargetChipProps {
  target: PlanningTarget;
  /** Wired in the TRAY — renders the ⨉ that drops this target from the set. */
  onRemove?: (identifier: string) => void;
  disabled?: boolean;
}

export function PlanningTargetChip({
  target,
  onRemove,
  disabled = false,
}: PlanningTargetChipProps) {
  const t = useTranslations('planningWorkspace.targets');

  return (
    <span
      data-testid="planning-target-chip"
      data-target-key={target.identifier}
      className="inline-flex max-w-full items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-kbd-x) py-(--spacing-kbd-y) text-xs text-(--el-text)"
    >
      <IssueTypeIcon type={target.kind as IssueType} className="size-3.5 shrink-0" />
      <span className="shrink-0 font-mono text-[0.9em] font-medium text-(--el-link)">
        {target.identifier}
      </span>
      <span className="min-w-0 truncate">{target.title}</span>
      {onRemove ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(target.identifier)}
          aria-label={t('remove', { item: target.identifier })}
          className="-mr-0.5 inline-flex shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-50"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * The COMPACT chip a sent turn carries (design panel 3): key only, because the
 * thread stores the target SET as identifiers (`PlanChangeSessionDto.targetKeys`
 * — the thread's scope, the authoritative record of what the turn was anchored
 * at) and never re-reads the titles. Two tones so the chip stays legible on both
 * bubble fills — the accent user bubble and the muted assistant one.
 */
export function PlanningTargetKeyChip({
  identifier,
  tone = 'muted',
}: {
  identifier: string;
  tone?: 'muted' | 'on-accent';
}) {
  return (
    <span
      data-testid="planning-turn-target"
      className={`inline-flex items-center rounded-(--radius-badge) px-(--spacing-chip-x) py-px font-mono text-[10px] font-semibold ${
        tone === 'on-accent'
          ? 'bg-(--el-accent-pressed) text-(--el-accent-text)'
          : 'bg-(--el-muted) text-(--el-text-secondary)'
      }`}
    >
      {identifier}
    </span>
  );
}
