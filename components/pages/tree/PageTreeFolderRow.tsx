'use client';

import type { ReactNode, Ref } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { RowDndMarks, rowDndClass, type RowDnd } from './PageTreeDnd';
import {
  CHEVRON_CLASS,
  glyphLeft,
  treeRowClass,
  type PageTreeDensity,
  type PageTreeFolderRowDto,
  type TreeItemProps,
} from './pageTreeRow';

// A FOLDER ROW of the `/pages` tree (Story MOTIR-5753 · MOTIR-7373) —
// `design/pages/pages--tree.mock.html` panels 1–3, `design-notes.md` § The page
// tree, "Folder row". `/items`' folder row, carried over: the `Folder` glyph in
// secondary ink, the name semibold, and the WHOLE row toggles it. A folder is
// ALWAYS expandable — whether it holds anything is only known after the read,
// and is then said in words (_No pages here_).
//
// The menu is the shared `FolderRowMenu` (`components/folders/`, moved there
// from `/items` by MOTIR-7374 with no visual change), built by the tree: New
// page here first (MOTIR-7373), then the shipped folder commands — New folder
// inside · Rename · Move to… | Move up · Move down | Delete… (MOTIR-7374) — and
// anchoring the folder Move to… picker. A reader without `page:edit` gets no
// menu at all — nothing drawn disabled (panel 8). While the folder is being
// RENAMED the tree hands in the shipped inline `FolderNameField` in place of
// the name and the menu.
//
// DRAG (MOTIR-7376, panel 11): a folder row is a drop TARGET only — INSIDE,
// drawn as the lavender tint and accent ring — and never draggable (a folder
// moves with Move to…, as in `/items`), so it has no handle.

export interface PageTreeFolderRowProps {
  row: PageTreeFolderRowDto;
  item: TreeItemProps;
  /** The treeitem element — the tree measures it and moves focus to it. */
  itemRef: Ref<HTMLDivElement>;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  /** The row menu, as the tree built it; `null` draws none (a reader without `page:edit`). */
  menu: ReactNode | null;
  /** The inline rename field, drawn in place of the name and the menu while it is open. */
  nameField?: ReactNode;
  /** Row metrics and chrome: `/pages`' rows, or the sidebar's compact ones. */
  density?: PageTreeDensity;
  /** The drag, when the tree offers it — a drop target only. */
  dnd?: RowDnd;
}

export function PageTreeFolderRow({
  row,
  item,
  itemRef,
  expanded,
  busy,
  onToggle,
  menu,
  nameField,
  density = 'default',
  dnd,
}: PageTreeFolderRowProps) {
  const t = useTranslations('folders');
  return (
    <div
      ref={itemRef}
      role="treeitem"
      aria-level={item.depth}
      aria-selected={false}
      aria-expanded={expanded}
      aria-busy={busy || undefined}
      aria-label={row.name}
      tabIndex={item.tabIndex}
      onKeyDown={item.onKeyDown}
      onFocus={item.onFocus}
      onClick={onToggle}
      data-testid="page-tree-folder"
      className={cn(treeRowClass(density), 'cursor-pointer', rowDndClass(dnd))}
      style={item.style}
    >
      <RowDndMarks dnd={dnd} glyphLeft={glyphLeft(item)} />
      <button
        type="button"
        tabIndex={-1}
        aria-label={
          expanded ? t('collapseAria', { name: row.name }) : t('expandAria', { name: row.name })
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={CHEVRON_CLASS}
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
      </button>
      <Folder className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
      {nameField ?? (
        <>
          <span className="min-w-0 truncate font-semibold text-(--el-text)">{row.name}</span>
          {menu}
        </>
      )}
    </div>
  );
}
