'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type {
  WorkItemMentionCandidate,
  WorkItemMentionStatusTone,
} from '@/components/ui/markdownEditorMentions';
import type { IssueType } from '@/lib/issues/parentRules';

// The `@` dropdown of the planning composer's target picker (Subtask MOTIR-1491;
// design `target-picker.mock.html` panels 1 + 4). Presentational: the composer
// owns the query, the results and the active row, so the keyboard lives with the
// input that has focus.
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
}: TargetSearchListboxProps) {
  const t = useTranslations('planningWorkspace.targets');
  const trimmed = query.trim();

  return (
    <div
      data-testid="target-search-popup"
      // Inset to the composer's own gutter (the form's `px-3`), so the popup
      // lines up with the input it belongs to instead of bleeding to the rail's
      // edges — the design draws it over the composer, not over the rail.
      className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-elevated)"
    >
      <p className="border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-[10px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
        {trimmed ? t('sectionLabelQuery', { query: trimmed }) : t('sectionLabel')}
      </p>

      {/* The four states, in the design's order. Each is text OUTSIDE the
          listbox — an empty `role="listbox"` violates aria-required-children. */}
      {tooShort ? (
        <p className="px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-muted)">
          {trimmed.length === 0 ? t('emptyHint') : t('keepTyping')}
        </p>
      ) : loading ? (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-muted)"
        >
          <Loader2 className="size-3.5 animate-spin text-(--el-text-faint)" aria-hidden="true" />
          {t('searching')}
        </p>
      ) : results.length === 0 ? (
        <p className="px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-muted)">
          {t('noResults', { query: trimmed })}
        </p>
      ) : (
        <div role="listbox" id={listboxId} aria-label={t('listboxLabel')} className="p-1">
          {results.map((item, index) => (
            <div
              key={item.id}
              id={`${optionIdPrefix}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => onHover(index)}
              // mousedown, not click: the input keeps focus (and its caret), so
              // the query range the pick consumes is still where it was.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(item);
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
                index === activeIndex
                  ? 'bg-(--el-surface-soft) text-(--el-text)'
                  : 'text-(--el-text)',
              )}
            >
              <IssueTypeIcon type={item.kind as IssueType} className="size-4 shrink-0" />
              <span
                className={cn(
                  'shrink-0 font-mono text-xs',
                  index === activeIndex ? 'text-(--el-text-secondary)' : 'text-(--el-text-muted)',
                )}
              >
                {item.identifier}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.status ? (
                <span className="ml-auto shrink-0">
                  <StatusPill status={item.status} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
