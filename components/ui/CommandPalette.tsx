'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * CommandPalette — a generic ⌘K-style action launcher.
 *
 * A Radix Dialog with a search input at the top and a grouped, keyboard-driven
 * action list below. Data-agnostic: it knows nothing about workspaces,
 * projects, or routes — the consumer passes typed `groups` whose actions carry
 * their own `onSelect`. The application composition lives in
 * `(authed)/_components/AppCommandPalette.tsx`.
 *
 * Filtering is a cheap client-side substring match against each action's
 * `label` (plus optional `keywords`). No fuzzy-match library — over-engineering
 * for v1; Epic 6's Search Story adds a server-fed "Search" group without
 * changing this primitive's shape.
 *
 * Keyboard: ↑/↓ move the highlight (wrapping), ↵ invokes the highlighted
 * action, esc closes (Radix). The input keeps focus throughout, so the active
 * option is tracked via `aria-activedescendant` (the combobox/listbox pattern)
 * rather than roving DOM focus.
 *
 * Internal query/highlight state is intentionally NOT reset on close: Radix
 * unmounts `Dialog.Content` when `open` is false, so `PaletteBody` remounts
 * fresh on every open and its state starts clean — no set-state-in-effect.
 *
 * @example
 * <CommandPalette
 *   open={open}
 *   onOpenChange={setOpen}
 *   groups={[{ heading: 'Navigation', actions: [{ id: 'dash', label: 'Go to Dashboard', onSelect: () => router.push('/dashboard') }] }]}
 * />
 */
export interface CommandAction {
  id: string;
  label: string;
  /** Optional keyboard-hint chip(s) shown right-aligned (e.g. 'G then I'). */
  kbd?: string;
  /** Optional trailing status tag shown right-aligned (e.g. 'Current'). */
  badge?: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Extra text matched by the filter in addition to `label`. */
  keywords?: string;
  /** Invoked on ↵ or click. The palette closes itself afterward. */
  onSelect: () => void;
}

export interface CommandGroup {
  heading: string;
  actions: CommandAction[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  placeholder?: string;
}

const LISTBOX_ID = 'command-palette-listbox';
const optionId = (index: number) => `command-palette-option-${index}`;

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  placeholder = 'Type a command or search…',
}: CommandPaletteProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay data-surface="overlay" className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-label="Command palette"
          // `data-surface="modal"` frosts the palette panel under glassmorphism
          // (it was missing, so the command palette never went glass).
          data-surface="modal"
          // Radix Dialog (v1.1.15) is modal-by-default (focus trap + outside
          // inert) but doesn't emit aria-modal itself — set it explicitly so
          // screen readers treat the rest of the page as inert while the
          // palette is open.
          aria-modal="true"
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-[15vh] z-50 w-[90vw] max-w-[40rem] -translate-x-1/2',
            'overflow-hidden rounded-(--radius-modal) bg-(--el-page-bg)',
            'border border-(--el-border) shadow-(--shadow-modal)',
            'focus:outline-none',
          )}
        >
          {/* Radix requires a Title for a11y; the visible search input is the
              accessible name, so the title is visually hidden. */}
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <PaletteBody
            groups={groups}
            placeholder={placeholder}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Flattened, filter-aware view of the groups for rendering + keyboard nav. */
interface FlatRow {
  /** The action this row invokes. */
  action: CommandAction;
  /** Its index among all visible actions (the keyboard cursor space). */
  index: number;
}

function PaletteBody({
  groups,
  placeholder,
  onClose,
}: {
  groups: CommandGroup[];
  placeholder: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter each group, drop empty groups, and number the surviving actions in
  // render order so the highlight index lines up with what the user sees.
  const { visibleGroups, flat } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const flatRows: FlatRow[] = [];
    const vGroups = groups
      .map((group) => {
        const actions = group.actions.filter((a) => {
          if (!needle) return true;
          return (
            a.label.toLowerCase().includes(needle) ||
            (a.keywords ? a.keywords.toLowerCase().includes(needle) : false)
          );
        });
        return { heading: group.heading, actions };
      })
      .filter((g) => g.actions.length > 0);
    for (const g of vGroups) {
      for (const a of g.actions) {
        flatRows.push({ action: a, index: flatRows.length });
      }
    }
    return { visibleGroups: vGroups, flat: flatRows };
  }, [groups, query]);

  // Clamp the highlight whenever the visible set shrinks (e.g. on typing).
  const activeIndex = flat.length === 0 ? -1 : Math.min(highlight, flat.length - 1);

  function move(delta: number) {
    if (flat.length === 0) return;
    const next = (activeIndex + delta + flat.length) % flat.length;
    setHighlight(next);
    // Keep the highlighted row in view.
    listRef.current?.querySelector(`#${optionId(next)}`)?.scrollIntoView({ block: 'nearest' });
  }

  function invoke(action: CommandAction) {
    onClose();
    action.onSelect();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = flat[activeIndex];
      if (row) invoke(row.action);
    }
    // esc bubbles to Radix Dialog, which closes + returns focus to the trigger.
  }

  return (
    <div role="combobox" aria-expanded aria-haspopup="listbox" aria-controls={LISTBOX_ID}>
      <div className="flex items-center gap-2 border-b border-(--el-border) px-4">
        <Search className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
        {/* A command palette must take focus the instant it opens. */}
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Search commands"
          aria-controls={LISTBOX_ID}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          className="h-12 w-full bg-transparent font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus:outline-none"
        />
      </div>

      <div
        ref={listRef}
        id={LISTBOX_ID}
        role="listbox"
        className="max-h-[50vh] overflow-y-auto py-2"
      >
        {flat.length === 0 ? (
          <p className="text-(--el-text-muted) px-4 py-6 text-center font-sans text-sm">
            No actions match.
          </p>
        ) : (
          visibleGroups.map((group) => (
            <div key={group.heading} className="px-2 pb-1">
              <div className="text-(--el-text-muted) px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider">
                {group.heading}
              </div>
              <ul role="presentation" className="flex flex-col">
                {group.actions.map((action) => {
                  const row = flat.find((r) => r.action.id === action.id)!;
                  const isActive = row.index === activeIndex;
                  return (
                    <li role="presentation" key={action.id}>
                      <button
                        type="button"
                        id={optionId(row.index)}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => invoke(action)}
                        onMouseMove={() => setHighlight(row.index)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left',
                          'font-sans text-sm text-(--el-text) focus:outline-none',
                          isActive && 'bg-(--el-surface)',
                        )}
                      >
                        {action.icon ? (
                          <span
                            aria-hidden
                            className="text-(--el-text-muted) inline-flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4"
                          >
                            {action.icon}
                          </span>
                        ) : null}
                        <span className="flex-1 truncate">{action.label}</span>
                        {action.badge ? (
                          <span className="text-(--el-text-muted) shrink-0 rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-[10px] font-medium uppercase tracking-wide">
                            {action.badge}
                          </span>
                        ) : null}
                        {action.kbd ? (
                          <kbd className="text-(--el-text-muted) shrink-0 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px]">
                            {action.kbd}
                          </kbd>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="text-(--el-text-muted) flex items-center gap-4 border-t border-(--el-border) px-4 py-2 font-sans text-[11px]">
        <span>
          <kbd className="font-mono">↑↓</kbd> to navigate
        </span>
        <span>
          <kbd className="font-mono">↵</kbd> to select
        </span>
        <span>
          <kbd className="font-mono">esc</kbd> to close
        </span>
      </div>
    </div>
  );
}
