'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// Run layout effects on the client, fall back to useEffect during SSR (the menu
// only mounts client-side anyway — see the `mounted` gate below).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// `false` during SSR / first hydration render, `true` on the client thereafter —
// gates the createPortal call so document.body is guaranteed present. Hydration-
// safe (matches the server's `false`) and avoids setState-in-effect.
const subscribeNoop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Combobox — an accessible select/combobox primitive (Subtask 2.3.4). A trigger
 * button (`role="combobox"`, `aria-haspopup="listbox"`) opens an anchored panel
 * holding an optional type-ahead filter and a `role="listbox"` of
 * `role="option"` rows. The active option is tracked with `aria-activedescendant`
 * on whichever control holds focus (the filter input when `searchable`, else the
 * listbox) — the CommandPalette pattern that already clears the STRICT axe sweep.
 *
 * Deliberately NOT built on the Radix Popover primitive: that injects
 * `aria-haspopup="dialog"` + dialog focus semantics onto its trigger, which
 * conflicts with the listbox combobox pattern. This is a self-contained anchored
 * dropdown (click-outside + Escape + focus return handled here) so the ARIA is
 * exactly the WAI-ARIA combobox shape.
 *
 * Composed by `components/issues/TypePicker` (searchable=false, 5 options) and
 * `ParentPicker` (searchable, async candidate list).
 */
export interface ComboboxOption<T extends string> {
  value: T;
  /** Primary text — also the accessible name of the option. */
  label: string;
  /** Extra text matched by the filter (e.g. a PROD-N identifier). */
  keywords?: string;
  /** Leading visual (a kind icon); decorative — label carries the name. */
  icon?: ReactNode;
  /** Trailing muted text (e.g. the identifier). */
  secondary?: string;
  /**
   * Optional section label. When consecutive options carry different `group`
   * values, a non-interactive header row is rendered at each transition (the
   * advanced filter's "Fields" / "Custom fields" / "Other" field menu). Pass
   * options pre-sorted by group; headers follow list order, so a group whose
   * every option is filtered out disappears with it. Decorative — not part of
   * the listbox's option indices, so keyboard nav is unaffected.
   */
  group?: string;
}

export interface ComboboxProps<T extends string> {
  options: ComboboxOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Accessible name for the trigger + listbox. */
  label: string;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  loading?: boolean;
  loadingText?: string;
  disabled?: boolean;
  /** id for the trigger button. */
  id?: string;
  className?: string;
  /**
   * Mount already-open (Subtask 2.5.5) — for an inline-edit cell that renders the
   * picker on a single click, so the menu is open immediately (mirrors
   * `DatePicker`'s `autoOpen`). Focus lands on the search input / listbox.
   */
  autoOpen?: boolean;
  /**
   * Fired whenever the menu transitions open → closed (a pick, Escape,
   * click-outside, or toggling the trigger). The inline-edit cell uses it to
   * leave edit mode and return to the static pill/avatar (Subtask 2.5.5).
   */
  onClose?: () => void;
  /**
   * Server-driven search mode (Subtask 6.9.2 — the link picker). When
   * `onQueryChange` is provided the type-ahead query is CONTROLLED by the parent
   * (`query`) and client-side filtering is SKIPPED — `options` is taken as the
   * server's authoritative result for the current query (the parent debounces
   * its fetch off `onQueryChange`, the same contract as `MultiSelectPicker`).
   * Omit both for the default self-filtering behaviour. The parent owns the
   * query lifecycle, so opening the menu does NOT reset it.
   */
  query?: string;
  onQueryChange?: (query: string) => void;
}

export function Combobox<T extends string>({
  options,
  value,
  onChange,
  label,
  placeholder = 'Select…',
  searchable = false,
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  loading = false,
  loadingText = 'Loading…',
  disabled = false,
  id,
  className,
  autoOpen = false,
  onClose,
  query: controlledQuery,
  onQueryChange,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(autoOpen);
  // Server-driven mode (6.9.2): when `onQueryChange` is provided the query is
  // controlled by the parent and client filtering is bypassed (the server's
  // `options` are authoritative). Otherwise the query is internal state.
  const serverFiltered = onQueryChange !== undefined;
  const [internalQuery, setInternalQuery] = useState('');
  const query = serverFiltered ? (controlledQuery ?? '') : internalQuery;
  const setQuery = (q: string) => (serverFiltered ? onQueryChange(q) : setInternalQuery(q));
  const [activeIndex, setActiveIndex] = useState(0);
  // The menu is portaled to <body> when the picker sits in a normal scroll
  // context, so it escapes a short table's overflow:hidden
  // (bug-inline-edit-clipped-when-table-short). Inside a focus-trapping dialog
  // (Radix Dialog, role="dialog") we render the menu INLINE instead: a portaled
  // menu would land outside the dialog's focus scope (focus-trap war → unstable)
  // AND the dialog centers with a CSS transform, which would break a fixed-
  // positioned child's viewport coordinates. A dialog scrolls rather than short-
  // clips, so inline is both safe and the original, proven behaviour. Only render
  // the portal once mounted, since createPortal needs document.body.
  const mounted = useMounted();
  // Viewport-anchored position for the portaled menu + the listbox's available
  // height, recomputed from the trigger rect on open / scroll / resize.
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [listMaxHeight, setListMaxHeight] = useState(256);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    // Server-driven mode: `options` is already the query's result — never filter
    // it again client-side (a substring re-filter would hide trigram / token
    // matches the server legitimately returned).
    if (serverFiltered || !searchable || query.trim() === '') return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        (o.secondary ? o.secondary.toLowerCase().includes(needle) : false) ||
        (o.keywords ? o.keywords.toLowerCase().includes(needle) : false),
    );
  }, [options, query, searchable, serverFiltered]);

  const selected = value != null ? (options.find((o) => o.value === value) ?? null) : null;

  // The active row, clamped to the (possibly just-filtered) list — DERIVED, not
  // an effect, so a shrinking filter never needs a setState-in-effect.
  const active = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  // Anchor the portaled menu to the trigger in VIEWPORT coordinates (position:
  // fixed), flipping above the trigger when there's more room there, and capping
  // the listbox height to the available space so it never runs off-screen.
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4; // matches the old mt-1
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const placeBelow = spaceBelow >= spaceAbove;
    const avail = Math.max(120, placeBelow ? spaceBelow : spaceAbove);
    // Reserve room for the optional search input + container padding.
    setListMaxHeight(Math.max(80, Math.min(256, avail - (searchable ? 52 : 12))));
    const style: CSSProperties = {
      position: 'fixed',
      left: Math.round(rect.left),
      minWidth: Math.round(rect.width),
    };
    if (placeBelow) style.top = Math.round(rect.bottom + gap);
    else style.bottom = Math.round(viewportH - rect.top + gap);
    setMenuStyle(style);
  }, [searchable]);

  // On open: focus the right control (the only side effect — query/active reset
  // happens in openMenu so this effect never calls setState).
  useEffect(() => {
    if (!(open && mounted)) return;
    const t = setTimeout(() => {
      if (searchable) inputRef.current?.focus();
      else listRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, mounted, searchable]);

  // Position the menu before paint, and keep it glued to the trigger while open
  // (ancestor scroll uses capture so a scrolling table re-anchors the menu).
  // Skip entirely for the inline (in-dialog) branch — it positions via CSS.
  useIsomorphicLayoutEffect(() => {
    if (!(open && mounted)) return;
    if (triggerRef.current?.closest('[role="dialog"]')) return;
    updatePosition();
    const onReflow = () => updatePosition();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, mounted, updatePosition, filtered.length]);

  // Click-outside closes, restoring focus to the trigger. The menu is portaled
  // out of containerRef, so a click on it must also count as "inside".
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active row in view.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  function openMenu() {
    // Uncontrolled mode resets its own type-ahead on open; server-driven mode
    // leaves the query to the parent (it owns the lifecycle — resets on form
    // open / relationship change), so reopening keeps the current results.
    if (!serverFiltered) setInternalQuery('');
    const sel = value != null ? options.findIndex((o) => o.value === value) : -1;
    setActiveIndex(sel >= 0 ? sel : 0);
    setOpen(true);
  }

  // Close the menu, notifying the consumer (Subtask 2.5.5's inline-edit cell
  // leaves edit mode on close). Every close path funnels through here.
  function closeMenu() {
    setOpen(false);
    onClose?.();
  }

  function closeAndRefocus() {
    closeMenu();
    triggerRef.current?.focus();
  }

  function commit(i: number) {
    const opt = filtered[i];
    if (!opt) return;
    onChange(opt.value);
    closeAndRefocus();
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(Math.min(active + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRefocus();
    }
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openMenu();
    }
  }

  const activeId = filtered.length > 0 ? optionId(active) : undefined;

  // Portal out to escape a short table's overflow:hidden — UNLESS we're inside a
  // focus-trapping dialog, where an inline menu is required (see the `mounted`
  // comment above). Reading the ref in render is safe: by the time `open` flips
  // true via a click the trigger is mounted; the only ref-null case is autoOpen,
  // used solely by inline-edit cells (always in a table, never a dialog) → portal.
  const inDialog = mounted ? !!triggerRef.current?.closest('[role="dialog"]') : false;

  const menuInner = (
    <>
      {searchable ? (
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label={searchPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onListKeyDown}
          placeholder={searchPlaceholder}
          className="border-(--el-border) bg-(--el-page-bg) mb-1 w-full rounded-(--radius-input) border px-(--spacing-control-x) py-(--spacing-control-y) text-sm focus-visible:outline-none"
        />
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        tabIndex={searchable ? -1 : 0}
        aria-activedescendant={searchable ? undefined : activeId}
        onKeyDown={searchable ? undefined : onListKeyDown}
        // Portaled menu caps its height to the measured viewport space (inline
        // style wins over max-h-64); the inline (in-dialog) menu keeps max-h-64.
        style={inDialog ? undefined : { maxHeight: listMaxHeight }}
        className="max-h-64 overflow-y-auto focus:outline-none"
      >
        {loading ? (
          <p className="text-(--el-text-muted) px-2.5 py-2 text-sm">{loadingText}</p>
        ) : filtered.length === 0 ? (
          <p className="text-(--el-text-muted) px-2.5 py-2 text-sm">{emptyText}</p>
        ) : (
          filtered.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === active;
            // A non-interactive group header at each group transition (in list
            // order, so a fully-filtered group's header drops with it). Not an
            // option row — keyboard nav over `filtered` is unaffected.
            const header =
              opt.group !== undefined && opt.group !== filtered[i - 1]?.group ? (
                <div
                  key={`group-${opt.group}`}
                  role="presentation"
                  className="px-(--spacing-control-x) pt-2 pb-1 font-mono text-[11px] font-semibold tracking-wider text-(--el-text-faint) uppercase"
                >
                  {opt.group}
                </div>
              ) : null;
            return (
              <Fragment key={opt.value}>
                {header}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
                    isActive ? 'bg-(--el-surface) text-(--el-text)' : 'text-(--el-text)',
                  )}
                >
                  {opt.icon ? <span aria-hidden>{opt.icon}</span> : null}
                  <span className="truncate">{opt.label}</span>
                  {opt.secondary ? (
                    <span className="text-(--el-text-muted) ml-auto truncate text-xs">
                      {opt.secondary}
                    </span>
                  ) : null}
                  {isSelected ? <Check className="ml-1 h-4 w-4 shrink-0" aria-hidden /> : null}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </>
  );

  // The shared menu panel. In a dialog: an inline absolute panel (the original,
  // proven layout). Otherwise: a body-portaled panel with viewport-anchored
  // fixed positioning that escapes every overflow ancestor.
  const menu = inDialog ? (
    <div
      ref={menuRef}
      className={cn(
        'absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-[18rem] rounded-(--radius-card) bg-(--el-page-bg) p-1',
        'shadow-(--shadow-elevated) border border-(--el-border)',
      )}
    >
      {menuInner}
    </div>
  ) : (
    <div
      ref={menuRef}
      // Width sizes to the widest option but never narrower than the trigger
      // (minWidth set in updatePosition) and is capped so a long label can't run
      // off-screen. Hidden until positioned to avoid a first-paint flash at 0,0.
      style={menuStyle ?? { position: 'fixed', visibility: 'hidden' }}
      className={cn(
        'z-50 w-max max-w-[18rem] rounded-(--radius-card) bg-(--el-page-bg) p-1',
        'shadow-(--shadow-elevated) border border-(--el-border)',
      )}
    >
      {menuInner}
    </div>
  );

  return (
    // `data-inner-dismiss` while the menu is open — see MultiSelectPicker:
    // an enclosing Radix layer's onEscapeKeyDown checks it so Esc closes the
    // MENU (our own handler) instead of dismissing the whole layer.
    <div ref={containerRef} data-inner-dismiss={open ? true : undefined} className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'border-(--el-border) bg-(--el-page-bg) flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-input) border px-(--spacing-control-x) text-sm',
          'focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2',
          'disabled:opacity-50',
          className,
        )}
      >
        {selected ? (
          <>
            {selected.icon ? <span aria-hidden>{selected.icon}</span> : null}
            <span className="text-(--el-text) truncate">{selected.label}</span>
            {selected.secondary ? (
              <span className="text-(--el-text-muted) ml-auto truncate text-xs">
                {selected.secondary}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-(--el-text-muted) truncate">{placeholder}</span>
        )}
        <ChevronsUpDown className="text-(--el-text-muted) ml-auto h-4 w-4 shrink-0" aria-hidden />
      </button>

      {open ? (inDialog ? menu : mounted ? createPortal(menu, document.body) : null) : null}
    </div>
  );
}
