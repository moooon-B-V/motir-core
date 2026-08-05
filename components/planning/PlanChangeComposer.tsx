'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AtSign, MessageCircleQuestionMark, Send } from 'lucide-react';
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
  /** The rail decides the prompt — a re-plan ASKS for the reason first
   *  (MOTIR-910), which outranks the targeted variant. */
  placeholder?: string;
  /** Pre-focus, for the re-plan ask (MOTIR-910). */
  autoFocus?: boolean;
  disabled?: boolean;
  /**
   * The planner's PENDING question (MOTIR-2226), or null when it is not waiting
   * on one. Non-null puts the composer in its answer state: the bar above the
   * input, and Send relabelled **Answer**.
   *
   * A report changes only the transcript; a QUESTION changes the composer — which
   * is the whole reason the state lives here. Questions are rare by construction,
   * and a rare thing that looks like the common thing gets skimmed; a skimmed
   * question is a thread that dies silently with each side waiting on the other.
   * So the ask is carried by the one region that is always on screen, next to the
   * control whose behaviour it changes.
   */
  awaitingQuestion?: string | null;
  /** Jump to the pending question in the transcript. */
  onSeeQuestion?: () => void;
}

export function PlanChangeComposer({
  draft,
  onDraftChange,
  targets,
  onAddTarget,
  onRemoveTarget,
  onSubmit,
  placeholder,
  autoFocus = false,
  disabled = false,
  awaitingQuestion = null,
  onSeeQuestion,
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

  const resolvedPlaceholder =
    placeholder ??
    (targets.length > 0 ? tc('composerPlaceholderTargets') : tc('composerPlaceholder'));
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
      {/* THE ANSWER BAR — a sibling above the input, where the target tray sits.
          Not an alert: nothing failed, the planner is simply waiting. Its copy
          names the state in words, so the live region announces it when the log
          updates, and the state is carried by THREE cues that are not colour —
          a word, a glyph, and the position of a control that changed. */}
      {awaitingQuestion !== null ? (
        <div
          data-testid="plan-change-awaiting"
          className="mb-2 flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2 text-(--el-warning-text)"
        >
          <MessageCircleQuestionMark className="size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] font-semibold tracking-wide uppercase">
              {tc('awaitingAnswer')}
            </span>
            <span className="block text-xs">{awaitingQuestion}</span>
          </div>
          {onSeeQuestion ? (
            // A real button, not link-coloured text on a tint (the AA rule for
            // this recipe).
            <button
              type="button"
              onClick={onSeeQuestion}
              className="shrink-0 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-[11px] font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {tc('seeQuestion')}
            </button>
          ) : null}
        </div>
      ) : null}

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
            // Pre-focused for a re-plan so the reason can be typed straight away
            // (MOTIR-910): the workspace is a full-screen route whose primary act
            // IS this composer.
            autoFocus={autoFocus}
            placeholder={resolvedPlaceholder}
            // The accessible name TRACKS the prompt (MOTIR-910's contract): a
            // screen reader must hear the same ask the placeholder shows.
            aria-label={resolvedPlaceholder}
            className="h-(--height-input) min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) pr-(--spacing-input-x) pl-8 text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
          />
        </div>
        {/* Send gains the WORD "Answer" while a question is pending — the third
            cue, and the one that says what pressing it will do. */}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={disabled || draft.trim().length === 0}
          aria-label={awaitingQuestion !== null ? tc('answer') : tc('send')}
        >
          <Send className="size-4" aria-hidden="true" />
          {awaitingQuestion !== null ? <span>{tc('answer')}</span> : null}
        </Button>
      </div>
    </form>
  );
}
