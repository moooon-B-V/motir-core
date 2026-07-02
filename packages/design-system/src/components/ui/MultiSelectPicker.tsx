'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, TriangleAlert, X } from 'lucide-react';
import { cn } from '../../utils/cn';

// Run the position measurement before paint on the client; fall back to
// useEffect during SSR (the listbox only ever opens client-side).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// `false` during SSR / first hydration render, `true` on the client thereafter —
// gates the createPortal call so document.body is guaranteed present (mirrors
// Combobox's useMounted). Hydration-safe and avoids setState-in-effect.
const subscribeNoop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

// MultiSelectPicker (Story 5.4 · Subtask 5.4.8) — the generic chip-input
// primitive, per design/work-items/labels-components-watch.mock.html panel 1:
// value chips (label · remove ×) + a type-to-filter input in an input-shaped
// box, with an anchored `aria-multiselectable` listbox of OptionRow-vocabulary
// rows (22px glyph slot · truncating label · trailing Check in --el-accent).
// The ONE new primitive the story earns — labels, components, and the future
// Epic-6 facet editors all compose it.
//
// PURE: options in, selection out — NO fetching inside. The caller owns the
// option set (filtering / debounced autocomplete) via the controlled `query`;
// `onCreate` adds the folksonomy create-row when the query matches nothing;
// `cap` disables the input at the limit (chips stay removable); a value's
// `tint` colours its chip + its option row's swatch dot (labels pass the
// name-hash tint; components pass none and get the neutral default).
//
// Keyboard (complete, the mock's panel-1 legend): type filters · ↑↓ moves the
// active row · Enter toggles it (multi-select: the menu does NOT close) ·
// Backspace on an empty input removes the last chip · Esc closes and returns
// focus to the input. `aria-activedescendant` tracks the active row, per the
// shipped Combobox a11y bar.

/** One of the six `--el-tint-*` pastel token names (chip + swatch colour). */
export type MultiSelectTint = 'peach' | 'rose' | 'mint' | 'lavender' | 'sky' | 'yellow';

export interface MultiSelectOption {
  id: string;
  label: string;
  /** Pastel tint for the chip + the option row's swatch dot; absent = neutral. */
  tint?: MultiSelectTint;
  /** Glyph for the option row's 22px slot and the chip (e.g. the component glyph). */
  glyph?: ComponentType<{ className?: string }>;
}

export interface MultiSelectPickerProps {
  /** The selected values, rendered as chips. */
  values: MultiSelectOption[];
  /** The current option set — the caller filters/fetches; no fetching inside. */
  options: MultiSelectOption[];
  /** Toggle an option from the listbox (add when unselected, remove when selected). */
  onToggle: (option: MultiSelectOption) => void;
  /** Remove a chip (the × button / Backspace-on-empty path). */
  onRemove: (value: MultiSelectOption) => void;
  /**
   * Folksonomy create — when present, a query matching no option (and no
   * selected value) case-insensitively appends the create-row.
   */
  onCreate?: (name: string) => void;
  /** The controlled filter query (the caller debounces its fetch off this). */
  query: string;
  onQueryChange: (query: string) => void;
  /** Per-value cap — at the cap the input disables; chips stay removable. */
  cap?: number;
  /** Accessible name for the input + the listbox. */
  label: string;
  placeholder: string;
  /** Localized create-row text for the current query (e.g. "Create 'perf-q3'"). */
  createLabel?: (query: string) => string;
  /** Localized accessible name for a chip's remove button. */
  removeLabel: (label: string) => string;
  /** Listbox empty state (e.g. "No components defined"). */
  emptyText?: string;
  /** Quiet line under the box (cap notice, admin link) — the mock's field-hint. */
  hint?: ReactNode;
  /** Inline error (the typed 422), announced via role="alert". */
  error?: string | null;
  /** Disables the whole control (a pending action). */
  disabled?: boolean;
  /** Extra classes for the chip-input BOX (the bordered element) — e.g. the
   * filter builder's dashed pending-row treatment (Subtask 6.1.4). */
  className?: string;
}

// Static class maps — Tailwind needs literal class strings per tint. The chip
// background routes through the DEDICATED `--el-label-1..6` ramp (MOTIR-1274 ·
// 1266.3): the picker's only `tint` consumer is the label chip (lib/labels/
// labelTint.ts maps a name → one of these six in this exact order), so a palette
// can tune label hues apart from roles/avatars. Each `--el-label-N` defaults to
// its prior `--el-tint-*` value, so this is a zero-visual-change rename.
const TINT_CHIP: Record<MultiSelectTint, string> = {
  peach: 'bg-(--el-label-1)',
  rose: 'bg-(--el-label-2)',
  mint: 'bg-(--el-label-3)',
  lavender: 'bg-(--el-label-4)',
  sky: 'bg-(--el-label-5)',
  yellow: 'bg-(--el-label-6)',
};

/**
 * A value chip — exported so the rail cards' DISPLAY / read-only modes render
 * the exact same chip the picker edits (mock panels 0 / 2 / 3). Neutral by
 * default (the Pill-neutral colours); a `tint` puts the hue in the background
 * with `--el-text-strong` text (finding #35 AA). With `onRemove` the trailing
 * × renders (12px, accessible name via `removeLabel`).
 */
export function ValueChip({
  option,
  onRemove,
  removeLabel,
  disabled,
}: {
  option: MultiSelectOption;
  onRemove?: (value: MultiSelectOption) => void;
  removeLabel?: (label: string) => string;
  disabled?: boolean;
}) {
  const Glyph = option.glyph;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium',
        option.tint
          ? cn(TINT_CHIP[option.tint], 'text-(--el-text-strong)')
          : 'bg-(--el-chip-bg) text-(--el-text-secondary) border border-(--el-chip-border)',
      )}
    >
      {Glyph ? <Glyph className="h-3 w-3 shrink-0 text-(--el-icon-muted)" aria-hidden /> : null}
      <span className="min-w-0 truncate">{option.label}</span>
      {onRemove ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(option)}
          aria-label={removeLabel ? removeLabel(option.label) : option.label}
          className={cn(
            '-mr-1 inline-flex items-center justify-center rounded-(--radius-badge) p-px focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            option.tint
              ? 'text-(--el-text-strong) opacity-65 hover:bg-(--el-text-strong)/10 hover:opacity-100'
              : 'text-(--el-icon-muted) hover:bg-(--el-muted) hover:text-(--el-text)',
          )}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** A pulse-skeleton chip (the mock's panel-6 loading grammar, at chip size). */
export function ChipSkeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn('h-[22px] animate-pulse rounded-(--radius-badge) bg-(--el-muted)', className)}
      aria-hidden
    />
  );
}

export function MultiSelectPicker({
  values,
  options,
  onToggle,
  onRemove,
  onCreate,
  query,
  onQueryChange,
  cap,
  label,
  placeholder,
  createLabel,
  removeLabel,
  emptyText,
  hint,
  error,
  disabled,
  className,
}: MultiSelectPickerProps) {
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // The listbox is PORTALED to <body> with viewport-anchored `position: fixed`
  // (MOTIR-1346) so it escapes the Advanced-filter popover's `overflow-hidden`
  // and its `overflow-y-auto` scroll body — an in-popover absolute panel is
  // trapped by those and gets cut off near the edge. Same mechanism as the
  // Combobox menu (the bug-inline-edit-clipped-when-table-short fix). Only render
  // the portal once mounted, since createPortal needs document.body.
  const mounted = useMounted();
  // Portal everywhere EXCEPT inside a focus-trapping modal (the Modal primitive,
  // `data-surface="modal"`), where a body-portaled option click fights the trap /
  // dismisses the modal — there we render the listbox INLINE. Same rule + marker
  // as the Combobox menu. Detected in a layout effect (not during render) so it's
  // set before paint with no ref-read-in-render.
  const [inModal, setInModal] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [listMaxHeight, setListMaxHeight] = useState(256);

  const atCap = cap != null && values.length >= cap;
  const inputDisabled = disabled || atCap;

  // The create-row appends when the trimmed query matches no option AND no
  // selected value case-insensitively (a case-insensitive match surfaces the
  // existing casing instead — mock panel 2).
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const hasExactMatch =
    options.some((o) => o.label.toLowerCase() === lower) ||
    values.some((v) => v.label.toLowerCase() === lower);
  const showCreate = !!onCreate && trimmed.length > 0 && !hasExactMatch;

  // The navigable rows: options first, the create-row last.
  const rowCount = options.length + (showCreate ? 1 : 0);
  const clampedActive = rowCount === 0 ? 0 : Math.min(activeIndex, rowCount - 1);
  const activeId = open && rowCount > 0 ? `${baseId}-opt-${clampedActive}` : undefined;

  // Close on outside pointerdown (the picker stays open across toggles). The
  // listbox is portaled out of rootRef, so a click on it must count as "inside"
  // (else the option click closes the menu before it registers).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Anchor the portaled listbox to the box in VIEWPORT coordinates (position:
  // fixed), flipping above when there's more room there and capping the height to
  // the available space so it never runs off-screen. Recomputed on open / scroll
  // / resize. (Mirrors Combobox.updatePosition — the proven, E2E-stable mechanism:
  // because the menu lives at <body> and is fully visible, a click never has to
  // scroll a clipped container to reach an option, so it stays put.)
  const updatePosition = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const gap = 4; // matches the old mt-1
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const placeBelow = spaceBelow >= spaceAbove;
    const avail = Math.max(120, placeBelow ? spaceBelow : spaceAbove);
    setListMaxHeight(Math.max(80, Math.min(256, avail - 8)));
    const style: CSSProperties = {
      position: 'fixed',
      left: Math.round(rect.left),
      minWidth: Math.round(rect.width),
    };
    if (placeBelow) style.top = Math.round(rect.bottom + gap);
    else style.bottom = Math.round(viewportH - rect.top + gap);
    setMenuStyle(style);
  }, []);

  // Detect (before paint) whether we sit inside a focus-trapping modal, to pick
  // the inline vs portal branch. Read in an effect, not during render.
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    setInModal(!!boxRef.current?.closest('[data-surface="modal"],[aria-modal="true"]'));
  }, [open]);

  // Position before paint, and keep it glued to the box while open (capture-phase
  // scroll so a scrolling dialog body re-anchors it).
  useIsomorphicLayoutEffect(() => {
    if (!(open && mounted) || inModal) return; // inline (modal) branch positions via CSS
    updatePosition();
    const onReflow = () => updatePosition();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, mounted, inModal, updatePosition, rowCount]);

  // The caller owns the query across a create: a rejected name stays in the
  // input for correction (mock panel 2); the card clears it on success.
  function commitRow(index: number) {
    const option = options[index];
    if (option) onToggle(option);
    else if (showCreate) onCreate?.(trimmed);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        // Consume the Esc that closes OUR listbox (stopPropagation included):
        // inside an enclosing dismissable layer (the 6.1.4 filter builder's
        // Radix Popover) the same keydown would otherwise also close the
        // whole dialog. With the listbox already closed, Esc passes through
        // to the container — the layered-dismiss order users expect.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (e.key === 'Backspace' && query.length === 0) {
      const last = values[values.length - 1];
      if (last) onRemove(last);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (rowCount === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((clampedActive + delta + rowCount) % rowCount);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && rowCount > 0) commitRow(clampedActive);
    }
  }

  // Inside a focus-trapping modal: render the listbox INLINE (in rootRef's
  // subtree). Otherwise: portal it to <body> so it escapes clipping ancestors.
  const wrapMenu = (el: ReactNode) => (inModal ? el : createPortal(el, document.body));

  return (
    // `data-inner-dismiss` (set while the listbox is open) lets an enclosing
    // Radix layer's `onEscapeKeyDown` defer to us: Radix listens for Escape
    // in the CAPTURE phase at the document, so our own bubble-phase handler
    // alone can't stop it from dismissing the whole popover/dialog first
    // (the 6.1.4 filter builder hit exactly this).
    <div ref={rootRef} data-inner-dismiss={open ? true : undefined} className="relative font-sans">
      {/* The box — input-shaped (mock panel 1): chips + the filter input. A
          click anywhere focuses the input; at the cap the box goes quiet but
          chips stay removable. */}
      <div
        ref={boxRef}
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex min-h-(--height-input) cursor-text flex-wrap items-center gap-1.5 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y)',
          'focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:ring-offset-1',
          inputDisabled && 'cursor-not-allowed bg-(--el-surface-soft)',
          className,
        )}
      >
        {values.map((v) => (
          <ValueChip
            key={v.id}
            option={v}
            onRemove={onRemove}
            removeLabel={removeLabel}
            disabled={disabled}
          />
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={label}
          disabled={inputDisabled}
          value={query}
          placeholder={values.length === 0 ? placeholder : undefined}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-[60px] flex-1 border-0 bg-transparent py-0.5 text-sm text-(--el-text) outline-none placeholder:text-(--el-text-muted) disabled:cursor-not-allowed"
        />
      </div>

      {open && mounted
        ? wrapMenu(
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
              data-menu-surface=""
              // Portal branch: viewport-anchored `position: fixed` (hidden until
              // positioned to avoid a first-paint flash at 0,0). Inline (modal)
              // branch: absolute, glued below the box, capped at max-h-64.
              style={
                inModal
                  ? { maxHeight: listMaxHeight }
                  : {
                      ...(menuStyle ?? { position: 'fixed', visibility: 'hidden' }),
                      maxHeight: listMaxHeight,
                    }
              }
              className={cn(
                'w-max max-w-72 min-w-60 overflow-y-auto rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-1 shadow-(--shadow-elevated)',
                inModal ? 'absolute top-full left-0 z-10 mt-1 max-h-64' : 'z-50',
              )}
            >
              {options.map((opt, i) => {
                const selected = values.some((v) => v.id === opt.id);
                const Glyph = opt.glyph;
                return (
                  <button
                    key={opt.id}
                    id={`${baseId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    // Keep focus in the input across a toggle (the menu stays open).
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitRow(i)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-option-active-bg) focus-visible:outline-none',
                      i === clampedActive && 'bg-(--el-option-active-bg)',
                    )}
                  >
                    <span className="flex w-[22px] shrink-0 items-center justify-center text-(--el-icon-muted)">
                      {opt.tint ? (
                        <span
                          aria-hidden
                          className={cn(
                            'h-2.5 w-2.5 rounded-full border border-(--el-border)',
                            TINT_CHIP[opt.tint],
                          )}
                        />
                      ) : Glyph ? (
                        <Glyph className="h-3.5 w-3.5" aria-hidden />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    <Check
                      aria-hidden
                      className={cn(
                        'h-4 w-4 shrink-0 text-(--el-accent-on-surface)',
                        selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </button>
                );
              })}

              {showCreate ? (
                <button
                  id={`${baseId}-opt-${options.length}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitRow(options.length)}
                  onMouseEnter={() => setActiveIndex(options.length)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-option-active-bg) focus-visible:outline-none',
                    clampedActive === options.length && 'bg-(--el-option-active-bg)',
                  )}
                >
                  <span className="flex w-[22px] shrink-0 items-center justify-center text-(--el-accent-on-surface)">
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {createLabel ? createLabel(trimmed) : trimmed}
                  </span>
                </button>
              ) : null}

              {options.length === 0 && !showCreate ? (
                <div className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-muted)">
                  {emptyText}
                </div>
              ) : null}
            </div>,
          )
        : null}

      {error ? (
        <p
          role="alert"
          className="mt-1.5 flex items-center gap-1.5 font-sans text-xs text-(--el-danger)"
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      {!error && hint ? (
        <div className="mt-1.5 font-sans text-xs text-(--el-text-helper)">{hint}</div>
      ) : null}
    </div>
  );
}
