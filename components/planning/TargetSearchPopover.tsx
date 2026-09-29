'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { TargetSearchListbox } from '@/components/planning/TargetSearchListbox';
import { useWorkItemTargetSearch } from '@/lib/hooks/useWorkItemTargetSearch';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';

// The planning composer's target SEARCH popover (Story MOTIR-6894 · Subtask
// MOTIR-6897; design `design/ai-chat/target-picker--search-and-canvas.mock.html`
// panels 2, 3 and 5).
//
// ⚠️ THE QUERY HAS ITS OWN FIELD. The shipped picker read its query INLINE from
// the message — the text after an `@`, which ended at the first whitespace, so
// `@plan approval` searched `plan`. Here the query lives in a field of its own,
// so a space is part of it and a bare number goes straight to the shared search
// (MOTIR-6896). The composer opens this from its Search control or from the `@`
// shortcut; both land here with focus in the field.
//
// A11Y — the ARIA 1.2 combobox pattern, with the FIELD as the combobox: it owns
// `aria-controls` / `aria-activedescendant`, and ↑/↓/Enter/Esc are handled here
// because focus never leaves it. The shell is a NON-modal `dialog` named like the
// control that opened it.
//
// The data is the shipped hook over the shipped endpoint; the rows, the four
// text states and the shell are `TargetSearchListbox`'s.

const LISTBOX_ID = 'planning-target-listbox';
const OPTION_PREFIX = 'planning-target-option';

export interface TargetSearchPopoverProps {
  /** The current target set — rows already in it are marked and not pickable. */
  targets: readonly PlanningTarget[];
  /** Add a target. The popover CLOSES after it (design panel 5's decision). */
  onPick: (target: PlanningTarget) => void;
  /** Close, handing focus back to the message field. */
  onClose: () => void;
}

/** Is this Enter confirming an IME candidate? The same signals the composer
 *  reads, minus the WebKit tail flag, which the popover tracks below. */
function isComposingEnter(event: KeyboardEvent<HTMLElement>, composing: boolean): boolean {
  return composing || event.nativeEvent.isComposing || event.keyCode === 229;
}

export function TargetSearchPopover({ targets, onPick, onClose }: TargetSearchPopoverProps) {
  const t = useTranslations('planningWorkspace.targets');
  const [query, setQuery] = useState('');
  // Tracked by candidate ID, not index (the composer's rule): when the result
  // set changes under the cursor the active row falls back to the first
  // PICKABLE one, with no reset effect.
  const [activeId, setActiveId] = useState<string | null>(null);
  const composingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const atLimit = targets.length >= MAX_PLANNING_TARGETS;
  const { results, loading, tooShort } = useWorkItemTargetSearch(query, !atLimit);
  const targetIds = new Set(targets.map((target) => target.id));
  const pickable = results.filter((row) => !targetIds.has(row.id));

  const found = activeId === null ? -1 : results.findIndex((r) => r.id === activeId);
  const activeRow =
    found >= 0 && !targetIds.has(results[found]!.id) ? results[found]! : (pickable[0] ?? null);
  const activeIndex = activeRow ? results.indexOf(activeRow) : -1;

  // Focus lands in the field on open — or, at the cap, where the field is
  // disabled, on the shell, so Esc still reaches the popover.
  useEffect(() => {
    (atLimit ? rootRef.current : fieldRef.current)?.focus();
  }, [atLimit]);

  // ⚠️ ESC MUST NOT REACH THE PLANNING SURFACE (design panel 5). The surface is
  // a Radix Dialog, and Radix listens for Escape on `document` in the CAPTURE
  // phase — before any React handler runs — so `stopPropagation` in the field's
  // own handler arrives too late and the whole surface closed behind a dismissed
  // search. Radix skips its dismiss when the event is already
  // `defaultPrevented`, and a WINDOW capture listener runs before the document
  // one, so this marks an Escape aimed at the popover before Radix sees it. The
  // field's own handler (bubble phase) still runs and does the closing.
  useEffect(() => {
    function onEscapeCapture(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) event.preventDefault();
    }
    window.addEventListener('keydown', onEscapeCapture, true);
    return () => window.removeEventListener('keydown', onEscapeCapture, true);
  }, []);

  // A click OUTSIDE closes it (design panel 5). The Search control is excluded:
  // its own click toggles the popover, and closing here first would reopen it.
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element | null;
      if (!target || rootRef.current?.contains(target)) return;
      if (target.closest?.('[data-testid="planning-target-trigger"]')) return;
      onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  function pick(candidate: WorkItemMentionCandidate) {
    if (targetIds.has(candidate.id)) return;
    onPick({
      id: candidate.id,
      identifier: candidate.identifier,
      title: candidate.title,
      kind: candidate.kind,
    });
  }

  /** Move the active row by `step` among the PICKABLE rows, wrapping. */
  function move(step: 1 | -1) {
    if (pickable.length === 0) return;
    const at = activeRow ? pickable.indexOf(activeRow) : -1;
    const next = pickable[(at + step + pickable.length) % pickable.length]!;
    setActiveId(next.id);
  }

  /** Esc closes and is SWALLOWED, so the planning surface's own Esc does not
   *  close the whole surface behind a dismissed search. */
  function closeOnEscape(event: KeyboardEvent<HTMLElement>): boolean {
    if (event.key !== 'Escape') return false;
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return true;
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (closeOnEscape(event)) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      // Enter here NEVER sends the message: it picks, or it does nothing.
      event.preventDefault();
      if (isComposingEnter(event, composingRef.current)) return;
      if (activeRow) pick(activeRow);
    }
  }

  const field = (
    <div className="flex items-center gap-2 border-b border-(--el-border-soft) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y)">
      <Search className="size-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />
      <input
        ref={fieldRef}
        type="text"
        role="combobox"
        aria-label={t('searchLabel')}
        aria-expanded={pickable.length > 0}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        {...(activeIndex >= 0 && results.length > 0 && !atLimit
          ? { 'aria-activedescendant': `${OPTION_PREFIX}-${activeIndex}` }
          : {})}
        data-testid="planning-target-search-field"
        value={query}
        disabled={atLimit}
        placeholder={t('searchPlaceholder')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onFieldKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          // Cleared on the next task — WebKit fires this BEFORE the keydown of
          // the Enter that confirmed the candidate (the composer's own guard).
          setTimeout(() => {
            composingRef.current = false;
          }, 0);
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-(--el-text) placeholder:text-(--el-text-secondary) focus:outline-none disabled:cursor-not-allowed"
      />
      <kbd
        aria-hidden="true"
        className="shrink-0 rounded-(--radius-kbd) border border-(--el-border-strong) px-(--spacing-kbd-x) font-mono text-[10px] text-(--el-text-secondary)"
      >
        Esc
      </kbd>
    </div>
  );

  return (
    <TargetSearchListbox
      rootRef={rootRef}
      dialogLabel={t('trigger')}
      onRootKeyDown={(event) => {
        closeOnEscape(event);
      }}
      field={field}
      listboxId={LISTBOX_ID}
      optionIdPrefix={OPTION_PREFIX}
      query={query}
      results={atLimit ? [] : results}
      loading={!atLimit && loading}
      tooShort={!atLimit && tooShort}
      activeIndex={activeIndex}
      targetIds={targetIds}
      limitMessage={atLimit ? t('limitReached', { max: MAX_PLANNING_TARGETS }) : null}
      onPick={pick}
      onHover={(index) => setActiveId(results[index]?.id ?? null)}
    />
  );
}
