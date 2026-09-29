'use client';

import type { KeyboardEventHandler, ReactNode, Ref } from 'react';
import { Loader2, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type {
  WorkItemMentionCandidate,
  WorkItemMentionStatusTone,
} from '@/components/ui/markdownEditorMentions';
import type { IssueType } from '@/lib/issues/parentRules';

// The planning composer's target SEARCH popover shell (Subtask MOTIR-1491, design
// `target-picker.mock.html` panels 1 + 4; since MOTIR-6897 the delta
// `target-picker--search-and-canvas.mock.html` panels 2 + 3, which give it its
// OWN search field as the first row). Presentational: `TargetSearchPopover` owns
// the query, the results and the active row, so the keyboard lives with the
// field that has focus.
//
// ⚠️ ROW GRAMMAR REUSED, not reinvented: type-hue icon · mono key · title · status
// Pill — the shipped work-item search row from the editor's `@` picker
// (5.8.5, `internal-links.mock.html` panel 3), down to the AA step-up on the
// active row (muted text drops under 4.5:1 on the `--el-surface` tint, so it
// becomes secondary there). It is a SEPARATE component rather than an import
// because that row lives inside the Tiptap suggestion module, and the chat
// composer is a plain input — importing it would drag the whole editor into this
// bundle for one row. The DATA source IS shared (`searchWorkItemMentions`).
//
// A11Y — the empty-listbox trap (`combobox-empty-listbox-a11y`): a `role="listbox"`
// must contain options, so the container is rendered ONLY when there are rows.
// The four query states are plain text OUTSIDE it, and "searching" is announced
// via `role="status"` rather than being a phantom option.

/** The work item's status as a Pill, by the shipped picker's row tone. */
function StatusPill({ status }: { status: { label: string; tone: WorkItemMentionStatusTone } }) {
  switch (status.tone) {
    case 'planned':
      return <Pill status="planned">{status.label}</Pill>;
    case 'in-progress':
      return <Pill status="in-progress">{status.label}</Pill>;
    case 'done':
      return <Pill status="done">{status.label}</Pill>;
    case 'warning':
      return <Pill severity="warning">{status.label}</Pill>;
    case 'neutral':
      return <Pill tone="neutral">{status.label}</Pill>;
  }
}

export interface TargetSearchListboxProps {
  /** The listbox element's id — the composer points `aria-controls` at it. */
  listboxId: string;
  /** `<option>` id prefix — the composer's `aria-activedescendant` space. */
  optionIdPrefix: string;
  query: string;
  results: WorkItemMentionCandidate[];
  loading: boolean;
  tooShort: boolean;
  activeIndex: number;
  onPick: (candidate: WorkItemMentionCandidate) => void;
  onHover: (index: number) => void;
  /** The popover's own search field, drawn as the first row (MOTIR-6897). */
  field?: ReactNode;
  /** Ids already in the TARGET SET — their rows stay listed, marked with the
   *  canvas node's `Target` pill, and cannot be picked (design panel 3). */
  targetIds?: ReadonlySet<string>;
  /** The set is at `MAX_PLANNING_TARGETS`: no row is offered, the line says why. */
  limitMessage?: string | null;
  /** Names the shell a non-modal `dialog` — the popover's accessible name. */
  dialogLabel?: string;
  rootRef?: Ref<HTMLDivElement>;
  /** Keys that reach the shell itself — the cap state, where the field is
   *  disabled and the shell holds focus so Esc still closes it. */
  onRootKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

export function TargetSearchListbox({
  listboxId,
  optionIdPrefix,
  query,
  results,
  loading,
  tooShort,
  activeIndex,
  onPick,
  onHover,
  field,
  targetIds,
  limitMessage = null,
  dialogLabel,
  rootRef,
  onRootKeyDown,
}: TargetSearchListboxProps) {
  const t = useTranslations('planningWorkspace.targets');
  const trimmed = query.trim();

  return (
    <div
      ref={rootRef}
      {...(dialogLabel ? { role: 'dialog', 'aria-label': dialogLabel, tabIndex: -1 } : {})}
      onKeyDown={onRootKeyDown}
      data-testid="target-search-popup"
      // Inset to the composer's own gutter (the form's `px-3`), so the popup
      // lines up with the input it belongs to instead of bleeding to the rail's
      // edges — the design draws it over the composer, not over the rail.
      className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-elevated) focus:outline-none"
    >
      <p className="border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-[10px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
        {trimmed ? t('sectionLabelQuery', { query: trimmed }) : t('sectionLabel')}
      </p>

      {field}
      {/* The states, in the design's order. Each is text OUTSIDE the listbox —
          an empty `role="listbox"` violates aria-required-children. */}
      {limitMessage ? (
        <p className="px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-secondary)">
          {limitMessage}
        </p>
      ) : tooShort ? (
        <p className="px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-secondary)">
          {trimmed.length === 0 ? t('emptyHint') : t('keepTyping')}
        </p>
      ) : loading ? (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-secondary)"
        >
          <Loader2 className="size-3.5 animate-spin text-(--el-text-faint)" aria-hidden="true" />
          {t('searching')}
        </p>
      ) : results.length === 0 ? (
        <p className="px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-secondary)">
          {t('noResults', { query: trimmed })}
        </p>
      ) : (
        <div role="listbox" id={listboxId} aria-label={t('listboxLabel')} className="p-1">
          {results.map((item, index) => {
            // ALREADY A TARGET: kept in the list so the item reads as FOUND, but
            // not pickable — `aria-disabled`, skipped by the arrows, inert to a
            // click (design panel 3). `addPlanningTarget` would refuse the
            // duplicate anyway; the row says so before anyone tries.
            const isTarget = targetIds?.has(item.id) ?? false;
            return (
              <div
                key={item.id}
                id={`${optionIdPrefix}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={isTarget || undefined}
                data-target={isTarget || undefined}
                onMouseEnter={() => {
                  if (!isTarget) onHover(index);
                }}
                // mousedown, not click: the field keeps focus, so the pick and
                // the focus hand-back happen from one place.
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!isTarget) onPick(item);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
                  isTarget ? 'cursor-default' : 'cursor-pointer',
                  index === activeIndex
                    ? 'bg-(--el-surface-soft) text-(--el-text)'
                    : 'text-(--el-text)',
                )}
              >
                <IssueTypeIcon type={item.kind as IssueType} className="size-4 shrink-0" />
                {/* One ink for both states: only the ACTIVE row is tinted, but a
                    conditional background is not something the ink scanner can
                    correlate with the branch that paints it, and
                    `--el-text-secondary` is AA on the tint and off it alike
                    (MOTIR-2477). */}
                <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
                  {item.identifier}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    isTarget && 'text-(--el-text-secondary)',
                  )}
                >
                  {item.title}
                </span>
                {isTarget ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-accent-on-surface) px-(--spacing-chip-x) font-mono text-[10px] font-bold tracking-wide text-(--el-accent-on-surface) uppercase">
                    <Target className="size-3" aria-hidden="true" />
                    {t('nodePill')}
                  </span>
                ) : item.status ? (
                  <span className="ml-auto shrink-0">
                    <StatusPill status={item.status} />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {!limitMessage && !tooShort && !loading && results.length > 0 ? (
        <p
          aria-hidden="true"
          className="flex gap-3 border-t border-(--el-border-soft) bg-(--el-card) px-(--spacing-control-x) py-1 text-[11px] text-(--el-text-secondary)"
        >
          <span>{t('hintMove')}</span>
          <span>{t('hintPick')}</span>
          <span>{t('hintClose')}</span>
        </p>
      ) : null}
    </div>
  );
}
