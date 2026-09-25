'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AtSign, CircleStop, MessageCircleQuestionMark, Send } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
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
// anchored at, shown as a chip tray above the field.
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
// A11Y — the ARIA 1.2 combobox pattern: the field is the combobox
// (`aria-expanded` / `aria-controls` / `aria-activedescendant`), the popup owns
// the listbox, and ↑/↓/Enter/Esc are handled here because focus never leaves the
// field. Esc closes the picker and is swallowed, so it does not also reach the
// workspace's "Esc closes" handler.

const LISTBOX_ID = 'planning-target-listbox';
const OPTION_PREFIX = 'planning-target-option';

/**
 * The composer's height CAP, in rows — the design's decision 1
 * (`design/ai-chat/design-notes.md`, the MULTI-LINE composer section; sheet 3).
 *
 * Eight is the last row count at which the transcript stays the LARGER region in
 * the worst case, measured at the split's FLOOR (a 327px footer: the capped field
 * plus the target tray plus the running bar) rather than at its default — the
 * floor being the binding case. It is a VERTICAL budget, so the resizable split
 * (MOTIR-6249) did not move it; a wider field only means the same paragraph
 * reaches the cap later.
 */
const COMPOSER_MAX_ROWS = 8;

/**
 * What the pinned bar says while a run is in flight, and what its control does.
 *
 * ⚠️ `stopping` IS NOT `stopped`, and the distinction is the point (MOTIR-4068).
 * The click is not the stop: the walk reads the flag at its NEXT phase boundary,
 * which can be a whole authoring session away, so between the two the surface
 * says the run is **stopping**. A run that keeps narrating after the UI called it
 * over is worse than a slow stop.
 */
export interface RunningBar {
  /** The current narration line — the same text the transcript's live region shows. */
  line: string;
  /** The user has asked for a stop and the walk has not reached its boundary yet. */
  stopping: boolean;
  onStop: () => void;
}

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
  /**
   * The RUNNING BAR (Story MOTIR-4054 · MOTIR-4068) — the live narration line
   * while a run works, and the **Stop** beside it. `null` when no run is in
   * flight, which is the state this component has always been in.
   *
   * ⚠️ IT TAKES THE ANSWER BAR'S SLOT, and that is a decision rather than a
   * convenience. `design/ai-chat/plan-change-run-live.mock.html` sheet 1: the
   * transcript is the only region that scrolls, so the pinned footer is the one
   * place always on screen — and the moment a stop is wanted is the moment the
   * run is visibly going wrong, which is exactly when a control on hover or below
   * a scroll does not exist. MOTIR-2225 measured the header full at `22rem`
   * (status dot + `Motir AI` + mode chip) and put the answer bar here for the
   * same reason.
   *
   * The two never coexist: awaiting an answer means the run is NOT running.
   */
  running?: RunningBar | null;
  /**
   * Offer the `@` TARGET picker. Default `true` — every shipped call site is a
   * planning turn anchored at committed work items, and none of them passes this.
   *
   * ⚠️ `false` FOR A PLAN REVISION (Story MOTIR-3595 · Subtask MOTIR-3601;
   * `design/ai-planning/design-notes.md` Part XII §B), and it is a correctness
   * flag rather than a styling one. The trigger opens `useWorkItemTargetSearch`,
   * which searches the project's COMMITTED work items; a revision is anchored at
   * the PLAN and the things it can name are PROPOSALS, which have no key to
   * mention until somebody approves them. Offering the picker there searches the
   * wrong universe and returns rows the instruction cannot act on.
   *
   * One prop rather than a second input, because a bespoke field would split the
   * placeholder/accessible-name contract, the disabled handling and the Send
   * button across two components.
   */
  mentions?: boolean;
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
  running = null,
  mentions = true,
}: PlanChangeComposerProps) {
  const t = useTranslations('planningWorkspace.targets');
  const tc = useTranslations('planningWorkspace.conversation');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  // TRUE while an IME is composing — and for the rest of the task in which the
  // composition ENDS. See `onCompositionEnd` for why the tail matters.
  const composingRef = useRef(false);
  const caretPlacedRef = useRef(false);
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
  const open = mentions && mention !== null && !dismissed && !atLimit && !disabled;
  const { results, loading, tooShort } = useWorkItemTargetSearch(mention?.query ?? '', open);

  const foundIndex = activeId === null ? -1 : results.findIndex((r) => r.id === activeId);
  const activeIndex = foundIndex >= 0 ? foundIndex : 0;

  // A PRE-FILLED draft — a starter chip's text, MOTIR-6210's seeded first turn —
  // is present before any typing, and a textarea whose value was set at mount
  // does not guarantee the caret lands at its end the way a one-line input does.
  // Placed ONCE: on every later focus the caret belongs to whoever moved it (a
  // click into the middle of a sentence, a Tab back into a half-typed draft).
  useEffect(() => {
    if (!autoFocus || caretPlacedRef.current) return;
    const el = inputRef.current;
    if (!el) return;
    caretPlacedRef.current = true;
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  /** Re-derive the `@` query from the field's current value + caret. */
  function syncMention(el: HTMLTextAreaElement) {
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

  /**
   * Is this Enter CONFIRMING an IME candidate rather than sending a message?
   *
   * Three signals, because no one of them is enough:
   *
   *  - `nativeEvent.isComposing` — the standard flag, true for every keydown
   *    dispatched while a composition session is open.
   *  - `keyCode === 229` — the legacy "the IME swallowed this key" code, still
   *    what some engines report where `isComposing` is not set.
   *  - `composingRef` — the WebKit guard. **Safari fires `compositionend`
   *    BEFORE the keydown of the Enter that confirmed the candidate**, so that
   *    keydown arrives with `isComposing: false` and both signals above miss it.
   *    Tracking the session ourselves and holding the flag to the end of the
   *    task is the only thing that catches it.
   *
   * Reported against assistant-ui (#8199, #8319), vercel-labs/agent-browser
   * (#1379) and bytedance/deer-flow (#1540) — one bug, four composers, and the
   * reason `isComposing` alone is not the fix it looks like.
   */
  function confirmsComposition(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    return composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // (1) An IME is composing — or has just finished. Do NOTHING: the Enter
    // belongs to the candidate, and sending a half-written message is the
    // failure people typing Chinese or Japanese would hit on their first turn.
    if (event.key === 'Enter' && confirmsComposition(event)) return;

    // (2) The `@` picker owns the keys while it is open — unchanged.
    if (open) {
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
      if (results.length > 0) {
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
          // Commits the row — NOT the message. Without the preventDefault the
          // send below would submit the half-typed `@bil` as a turn.
          event.preventDefault();
          pick(results[activeIndex]!);
          return;
        }
      }
      // An OPEN picker with no rows falls through: there is no row to commit,
      // so Enter still sends, exactly as it did when the field was an `<input>`
      // and the browser submitted the form for us.
    }

    // (3) Enter SENDS and (4) Shift+Enter breaks the line. A textarea submits no
    // form of its own, so the send is explicit — and it goes through
    // `requestSubmit()` rather than calling `submit()` directly, so the trim,
    // the empty-message refusal and the `disabled` guard keep exactly one home.
    //
    // (5) ↑/↓ with the picker CLOSED never reach here, so the caret moves
    // between lines the way it does in any other multi-line field.
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  /** The visible `@` affordance (design panel 2d) — focuses the field and opens
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
      {/* THE RUNNING BAR — the live line and the STOP, in the pinned footer.
          NOT an alert and NOT a warning tint: nothing has failed, a run is simply
          working. It reuses `--el-surface-soft`, which is the fill the shipped
          progress row already carries, so this is that row moved into the region
          that never scrolls and given a control — composition, not a new
          treatment (`design/ai-chat/plan-change-run-live.mock.html` sheet 4's
          token map). */}
      {running !== null ? (
        <div
          data-testid="plan-change-running-bar"
          className="mb-2 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2"
        >
          <Spinner size="sm" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs text-(--el-text-secondary)">
            {running.stopping ? tc('stopping') : running.line}
          </span>
          {/* SECONDARY, never destructive. A stop is a DECISION, and the whole
              card turns on it not reading as one: if stopping looks like throwing
              work away, people wait runs out instead and the control is
              decorative. So no `--el-danger`, and the label is a word rather than
              an icon alone. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={running.onStop}
            disabled={running.stopping}
            leftIcon={<CircleStop className="size-4" aria-hidden="true" />}
            data-testid="plan-change-stop"
          >
            {running.stopping ? tc('stoppingAction') : tc('stop')}
          </Button>
        </div>
      ) : null}

      {/* THE ANSWER BAR — a sibling above the field, where the target tray sits.
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

      {mentions && targets.length > 0 ? (
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

      {/* ⚠️ `items-end`, NOT `items-center` — the design's decision 2. Send is a
          SIBLING of the field in this row, not a child of it, so a growing field
          walks Send (and the absolutely-positioned `@` trigger) down the box as
          the caret moves away from them. Bottom-aligning holds both a fixed
          distance from the caret's last line. The stated price: at rest the row
          is `--height-input` and Send is `--height-btn-sm`, so Send sits 6px
          lower than today's centring — the one visible change to a composer
          nobody has typed into. */}
      <div className="flex items-end gap-2">
        {/* The combobox WRAPPER, per the shipped `CommandPalette` pattern: the
            role sits on the container so the message field keeps its native
            textbox role (every existing consumer — and the acceptance spec —
            addresses it that way, and a `<textarea>` carries that role exactly
            as the `<input>` did), while `aria-controls` /
            `aria-activedescendant` on the field still voice the active row. */}
        {/* ⚠️ WITHOUT MENTIONS THE COMBOBOX ROLE GOES TOO, not just the button.
            A `role="combobox"` that owns no popup and can never expand is a lie
            told to a screen reader — it promises an autocomplete the surface does
            not have. So the wrapper degrades to a plain `div`, and the field keeps
            its native textbox role, which is what every consumer addresses it by
            anyway. */}
        <div
          {...(mentions
            ? {
                role: 'combobox' as const,
                'aria-expanded': open,
                'aria-haspopup': 'listbox' as const,
                // Named unconditionally (the role REQUIRES it): the listbox is
                // the popup this combobox owns whenever it has one, and an id
                // pointing at nothing is how a closed combobox reads.
                'aria-controls': LISTBOX_ID,
              }
            : {})}
          // ⚠️ NOT a flex row any more. `Textarea` renders its field inside the
          // design system's `FormField` wrapper, and a flex child with no
          // `flex-1` of its own would size to content instead of filling the
          // row. Block flow lets the wrapper fill this container and the field
          // fill the wrapper, which is the geometry the design draws.
          className="relative min-w-0 flex-1"
        >
          {mentions ? (
            <button
              type="button"
              onClick={triggerMention}
              disabled={disabled || atLimit}
              aria-label={t('trigger')}
              data-testid="planning-target-trigger"
              // `bottom-1.5` rather than vertical centring: the trigger is
              // absolutely positioned, so it followed the row's `items-center`
              // to the middle of a grown field. 6px above the field's bottom
              // edge in every one of the design's thirteen sheets.
              className="absolute bottom-1.5 left-1.5 z-10 inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-50"
            >
              <AtSign className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <Textarea
            ref={inputRef}
            autoGrow
            rows={1}
            maxRows={COMPOSER_MAX_ROWS}
            value={draft}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              // Cleared on the NEXT task, deliberately. WebKit fires this
              // BEFORE the keydown of the Enter that confirmed the candidate,
              // so clearing it synchronously would hand that keydown a field
              // that looks idle — which is the bug this flag exists for.
              setTimeout(() => {
                composingRef.current = false;
              }, 0);
            }}
            {...(mentions ? { 'aria-autocomplete': 'list' as const } : {})}
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
            // The composer's own tokens, overriding the primitive's defaults
            // (`cn` is `twMerge`, and this className is last). Three of them are
            // the multi-line change rather than a carry-over:
            //
            //  • `min-h-(--height-input)` replaces `h-(--height-input)` — the
            //    shipped 44px becomes the FLOOR instead of the height, and the
            //    primitive writes the measured height above it.
            //  • the VERTICAL PADDING is DERIVED, not the `--spacing-input-y`
            //    token: one row has to come to `--height-input` exactly, which
            //    is `(--height-input − line-height − both borders) ÷ 2`. The
            //    token's 12px gives 46px — a visible 2px growth on a field
            //    nobody has typed into. Written as the arithmetic so it stays
            //    exact under every density and type scale the axes produce.
            //  • `focus:ring-0 focus:ring-offset-0` retires the primitive's
            //    plain-`focus` ring, which paints on a mouse click and carries
            //    an offset. The composer's ring is `focus-visible` and
            //    offsetless, as it has always been, and `twMerge` cannot reach
            //    across the two modifiers to do this for us.
            //
            // The placeholder paints on this field's OWN `--el-surface` fill
            // (4.17:1 for muted), and it is load-bearing here — the prompt IS
            // the placeholder, and the accessible name tracks it. Secondary is
            // 6.24:1 on that surface.
            className={`min-h-(--height-input) py-[calc((var(--height-input)-(var(--text-sm)*var(--text-sm--line-height))-2px)/2)] min-w-0 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) pr-(--spacing-input-x) ${mentions ? 'pl-8' : 'pl-(--spacing-input-x)'} text-sm text-(--el-text) placeholder:text-(--el-text-secondary) focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60`}
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
