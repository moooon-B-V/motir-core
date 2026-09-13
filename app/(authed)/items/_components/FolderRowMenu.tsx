'use client';

import { useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Ellipsis } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';

// A folder row's ACTIONS MENU (Story MOTIR-5308 · MOTIR-5344), the design's
// panel 2. A work-item row has no menu — its click opens the quick view, which
// carries every door (MOTIR-4258) — but a folder has no quick view, so its row is
// the only place its actions can live.
//
// This is the SHELL: it renders whatever ordered entries it is given. The
// create-and-rename card supplies "New folder inside" and "Rename"; the move and
// delete cards append their entries (and separators) to the same list rather
// than building a second menu.
//
// ⚠️ The menu is portaled, but React events still bubble through the portal to
// the treegrid row, whose own keys move row focus (arrows) and toggle the folder
// (Enter) and whose click toggles it. Every event this menu handles stops there.

export type FolderMenuEntry =
  | {
      kind: 'item';
      key: string;
      label: string;
      icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
      onSelect: () => void;
      disabled?: boolean;
    }
  | { kind: 'separator'; key: string };

export function FolderRowMenu({ label, entries }: { label: string; entries: FolderMenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Whether the menu closed because an entry was chosen: that entry decides
  // where focus goes next (a name input), so the trigger must not take it back.
  const chose = useRef(false);

  const enabledItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const items = enabledItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) chose.current = false;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'relative z-10 ml-auto inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
          open && 'bg-(--el-border-soft) text-(--el-text)',
        )}
      >
        <Ellipsis className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content
        width={220}
        align="end"
        className="p-1"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          enabledItems()[0]?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (chose.current) e.preventDefault();
        }}
      >
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
          {entries.map((entry) =>
            entry.kind === 'separator' ? (
              <div key={entry.key} role="separator" className="mx-1.5 my-1 h-px bg-(--el-border)" />
            ) : (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                onClick={() => {
                  chose.current = true;
                  setOpen(false);
                  entry.onSelect();
                }}
                className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-[13px] text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none disabled:cursor-default disabled:text-(--el-text-faint) disabled:hover:bg-transparent"
              >
                <entry.icon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                <span className="flex-1 truncate">{entry.label}</span>
              </button>
            ),
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}
