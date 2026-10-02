'use client';

import type { Ref } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  FolderRowMenu,
  type FolderMenuEntry,
} from '@/app/(authed)/items/_components/FolderRowMenu';
import {
  CHEVRON_CLASS,
  TREE_ROW_CLASS,
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
// The menu is `/items`' shipped `FolderRowMenu` (MOTIR-7374 moves it to a shared
// `folders` directory, with no visual change). This card supplies its first
// entry, **New page here**; the shipped folder commands are appended after it
// through `entries` (MOTIR-7374). A reader without `page:edit` gets no menu at
// all — nothing drawn disabled (panel 8).

export interface PageTreeFolderRowProps {
  row: PageTreeFolderRowDto;
  item: TreeItemProps;
  /** The treeitem element — the tree measures it and moves focus to it. */
  itemRef: Ref<HTMLDivElement>;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  /** The row menu's entries; `null` draws no menu (a reader without `page:edit`). */
  menu: FolderMenuEntry[] | null;
}

export function PageTreeFolderRow({
  row,
  item,
  itemRef,
  expanded,
  busy,
  onToggle,
  menu,
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
      className={cn(TREE_ROW_CLASS, 'cursor-pointer')}
      style={item.style}
    >
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
      <span className="min-w-0 truncate font-semibold text-(--el-text)">{row.name}</span>
      {menu ? <FolderRowMenu label={t('actionsAria', { name: row.name })} entries={menu} /> : null}
    </div>
  );
}
