'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

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
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!searchable || query.trim() === '') return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        (o.secondary ? o.secondary.toLowerCase().includes(needle) : false) ||
        (o.keywords ? o.keywords.toLowerCase().includes(needle) : false),
    );
  }, [options, query, searchable]);

  const selected = value != null ? (options.find((o) => o.value === value) ?? null) : null;

  // The active row, clamped to the (possibly just-filtered) list — DERIVED, not
  // an effect, so a shrinking filter never needs a setState-in-effect.
  const active = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  // On open: focus the right control (the only side effect — query/active reset
  // happens in openMenu so this effect never calls setState).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (searchable) inputRef.current?.focus();
      else listRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, searchable]);

  // Click-outside closes, restoring focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Keep the active row in view.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  function openMenu() {
    setQuery('');
    const sel = value != null ? options.findIndex((o) => o.value === value) : -1;
    setActiveIndex(sel >= 0 ? sel : 0);
    setOpen(true);
  }

  function closeAndRefocus() {
    setOpen(false);
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

  return (
    <div ref={containerRef} className="relative">
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
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'border-(--el-border) bg-(--el-page-bg) flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm',
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

      {open ? (
        <div
          className={cn(
            'absolute left-0 right-0 top-full z-50 mt-1 rounded-(--radius-card) bg-(--el-page-bg) p-1',
            'shadow-(--shadow-elevated) border border-(--el-border)',
          )}
        >
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
              className="border-(--el-border) bg-(--el-page-bg) mb-1 w-full rounded-(--radius-sm) border px-2.5 py-1.5 text-sm focus-visible:outline-none"
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
                return (
                  <div
                    key={opt.value}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(i)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-(--radius-sm) px-2.5 py-1.5 text-sm',
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
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
