'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AtSign, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PlanningTargetChip } from '@/components/planning/PlanningTargetChip';
import { TargetSearchListbox } from '@/components/planning/TargetSearchListbox';
import { useWorkItemTargetSearch } from '@/lib/hooks/useWorkItemTargetSearch';
import {
  clearMentionQuery,
  findMentionQuery,
  MAX_PLANNING_TARGETS,
  type MentionQueryRange,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';

// The planning chat's COMPOSER — the message input plus the `@`-mention TARGET
// picker (Subtask MOTIR-1491; design `design/ai-chat/target-picker.mock.html`
// panels 1, 2 and 4). Typing `@` (or pressing the `@` button) searches the
// project's work items; picking one adds it to the TARGET SET the turn is
// anchored at, shown as a chip tray above the input.
//
// The picked chip goes to the TRAY, not inline into the message text (design
// panel 2): the target set is structured data the session is scoped by, not
// prose — so the `@query` token is consumed on pick and the sentence the user was
// typing closes over the gap.
//
// The SET lives in the host (`PlanningWorkspaceHost`), not here, because the
// CANVAS highlights it too; this component renders it and reports adds/removes.
// The draft text lives in the rail, whose starter hints prefill it.
//
// A11Y — the ARIA 1.2 combobox pattern: the input is the combobox
// (`aria-expanded` / `aria-controls` / `aria-activedescendant`), the popup owns
// the listbox, and ↑/↓/Enter/Esc are handled here because focus never leaves the
// input. Esc closes the picker and is swallowed, so it does not also reach the
// workspace's "Esc closes" handler.

const LISTBOX_ID = 'planning-target-listbox';
const OPTION_PREFIX = 'planning-target-option';

export interface PlanChangeComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  targets: readonly PlanningTarget[];
  onAddTarget: (target: PlanningTarget) => void;
  onRemoveTarget: (identifier: string) => void;
  /** Submit the turn. The composer clears the draft; the TARGETS persist across
   *  turns until the user removes them (design panel 3). */
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function PlanChangeComposer({
  draft,
  onDraftChange,
  targets,
  onAddTarget,
  onRemoveTarget,
  onSubmit,
  disabled = false,
}: PlanChangeComposerProps) {
  const t = useTranslations('planningWorkspace.targets');
  const tc = useTranslations('planningWorkspace.conversation');

  const inputRef = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<MentionQueryRange | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Tracked by candidate ID, not index: when the result set changes under the
  // cursor the active row falls back to the first automatically, with no reset
  // effect (set-state-in-effect is a lint error in this repo).
  const [activeId, setActiveId] = useState<string | null>(null);

  const atLimit = targets.length >= MAX_PLANNING_TARGETS;
  // Closed while the turn is in flight too: the composer is locked, so an open
  // dropdown would be a control the user cannot act on.
  const open = mention !== null && !dismissed && !atLimit && !disabled;
  const { results, loading, tooShort } = useWorkItemTargetSearch(mention?.query ?? '', open);

  const foundIndex = activeId === null ? -1 : results.findIndex((r) => r.id === activeId);
  const activeIndex = foundIndex >= 0 ? foundIndex : 0;

  /** Re-derive the `@` query from the input's current value + caret. */
  function syncMention(el: HTMLInputElement) {
    setMention(findMentionQuery(el.value, el.selectionStart ?? el.value.length));
  }

  function pick(candidate: WorkItemMentionCandidate) {
    onAddTarget({
      id: candidate.id,
      identifier: candidate.identifier,
      title: candidate.title,
      kind: candidate.kind,
    });
    if (mention) {
      const next = clearMentionQuery(draft, mention);
      onDraftChange(next.text);
      // Restore the caret where the query used to be, so typing continues mid
      // sentence rather than jumping to the end.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
    setMention(null);
    setActiveId(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === 'Escape') {
      // Swallowed: the workspace's own Esc handler must not close the whole
      // surface because the user was dismissing a dropdown.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return;
    }
    if (event.key === 'Tab') {
      setDismissed(true);
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveId(results[(activeIndex + 1) % results.length]!.id);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveId(results[(activeIndex - 1 + results.length) % results.length]!.id);
      return;
    }
    if (event.key === 'Enter') {
      // Commits the row — NOT the message. Without the preventDefault the form
      // would submit the half-typed `@bil` as a turn.
      event.preventDefault();
      pick(results[activeIndex]!);
    }
  }

  /** The visible `@` affordance (design panel 2d) — focuses the input and opens
   *  the picker, inserting the trigger the keyboard path would have typed. */
  function triggerMention() {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = `${needsSpace ? ' ' : ''}@`;
    const next = `${before}${insert}${draft.slice(caret)}`;
    const nextCaret = before.length + insert.length;
    onDraftChange(next);
    setDismissed(false);
    setMention({ query: '', start: nextCaret - 1, end: nextCaret });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onSubmit(text);
    onDraftChange('');
    setMention(null);
  }

  return (
    <form onSubmit={submit} className="relative border-t border-(--el-border) px-3 py-3">
      {targets.length > 0 ? (
        <div
          role="group"
          aria-label={t('trayLabel', { count: targets.length })}
          data-testid="planning-target-tray"
          className="mb-2 flex flex-wrap items-center gap-1.5"
        >
          <span className="font-mono text-[10px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
            {t('trayLabel', { count: targets.length })}
          </span>
          {targets.map((target) => (
            <PlanningTargetChip
              key={target.identifier}
              target={target}
              onRemove={onRemoveTarget}
              disabled={disabled}
            />
          ))}
          {atLimit ? (
            <span className="text-[11px] text-(--el-text-muted)">
              {t('limitReached', { max: MAX_PLANNING_TARGETS })}
            </span>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <TargetSearchListbox
          listboxId={LISTBOX_ID}
          optionIdPrefix={OPTION_PREFIX}
          query={mention?.query ?? ''}
          results={results}
          loading={loading}
          tooShort={tooShort}
          activeIndex={activeIndex}
          onPick={pick}
          onHover={(index) => setActiveId(results[index]?.id ?? null)}
        />
      ) : null}

      <div className="flex items-center gap-2">
        {/* The combobox WRAPPER, per the shipped `CommandPalette` pattern: the
            role sits on the container so the message field keeps its native
            textbox role (every existing consumer — and the acceptance spec —
            addresses it that way), while `aria-controls` /
            `aria-activedescendant` on the input still voice the active row. */}
        <div
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          // Named unconditionally (the role REQUIRES it): the listbox is the
          // popup this combobox owns whenever it has one, and an id pointing at
          // nothing is how a closed combobox reads.
          aria-controls={LISTBOX_ID}
          className="relative flex min-w-0 flex-1 items-center"
        >
          <button
            type="button"
            onClick={triggerMention}
            disabled={disabled || atLimit}
            aria-label={t('trigger')}
            data-testid="planning-target-trigger"
            className="absolute left-1.5 inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-50"
          >
            <AtSign className="size-4" aria-hidden="true" />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            aria-autocomplete="list"
            {...(open && results.length > 0
              ? {
                  'aria-controls': LISTBOX_ID,
                  'aria-activedescendant': `${OPTION_PREFIX}-${activeIndex}`,
                }
              : {})}
            onChange={(event) => {
              onDraftChange(event.target.value);
              setDismissed(false);
              syncMention(event.target);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => syncMention(event.currentTarget)}
            onClick={(event) => syncMention(event.currentTarget)}
            disabled={disabled}
            placeholder={
              targets.length > 0 ? tc('composerPlaceholderTargets') : tc('composerPlaceholder')
            }
            aria-label={tc('composerPlaceholder')}
            className="h-(--height-input) min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) pr-(--spacing-input-x) pl-8 text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={disabled || draft.trim().length === 0}
          aria-label={tc('send')}
        >
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
