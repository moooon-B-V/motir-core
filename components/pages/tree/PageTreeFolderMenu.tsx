'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, FolderInput, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { FolderPickerPopover } from '@/components/folders/FolderPicker';
import { FolderRowMenu, type FolderMenuEntry } from '@/components/folders/FolderRowMenu';

// A FOLDER ROW's menu in the `/pages` tree (Story MOTIR-5753 · MOTIR-7373 /
// MOTIR-7374) — `design/pages/pages--tree.mock.html` panel 2, `design-notes.md`
// § The page tree, "Row menus": **New page here** first, then the shipped
// `/items` folder menu composed unchanged — New folder inside · Rename · Move
// to… | Move up · Move down | Delete…. The shipped folder Move up / Move down
// keep their shipped behaviour: drawn DISABLED on the first / last folder (the
// design's open question records that page rows draw theirs ABSENT instead).
//
// The folder commands are present only when the tree hands them in (`commands`)
// — a reader who may write pages but not folders gets New page here alone. The
// menu anchors the shipped folder Move to… picker (`FolderPickerPanel`), as on
// `/items`.

export interface PageTreeFolderCommands {
  onNewFolderInside: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  /** The first folder of its level: Move up is drawn disabled. */
  isFirst: boolean;
  /** The last folder of its level: Move down is drawn disabled. */
  isLast: boolean;
}

export interface PageTreeFolderMenuProps {
  name: string;
  onNewPageHere: () => void;
  commands?: PageTreeFolderCommands;
  /** Entries a later card appends (the `folderMenuEntries` seam). */
  extraEntries?: FolderMenuEntry[];
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  picker: ReactNode;
}

export function PageTreeFolderMenu({
  name,
  onNewPageHere,
  commands,
  extraEntries = [],
  pickerOpen,
  onPickerOpenChange,
  picker,
}: PageTreeFolderMenuProps) {
  const t = useTranslations('pages.tree');
  const tf = useTranslations('folders');
  const entries: FolderMenuEntry[] = [
    {
      kind: 'item',
      key: 'new-page-here',
      label: t('newPageHere'),
      icon: Plus,
      onSelect: onNewPageHere,
    },
  ];
  if (commands) {
    entries.push(
      {
        kind: 'item',
        key: 'new-folder-inside',
        label: tf('newFolderInside'),
        icon: FolderPlus,
        onSelect: commands.onNewFolderInside,
      },
      {
        kind: 'item',
        key: 'rename',
        label: tf('rename'),
        icon: Pencil,
        onSelect: commands.onRename,
      },
      {
        kind: 'item',
        key: 'move-to',
        label: tf('moveTo'),
        icon: FolderInput,
        onSelect: commands.onMoveTo,
      },
      { kind: 'separator', key: 'order' },
      {
        kind: 'item',
        key: 'move-up',
        label: tf('moveUp'),
        icon: ArrowUp,
        disabled: commands.isFirst,
        onSelect: commands.onMoveUp,
      },
      {
        kind: 'item',
        key: 'move-down',
        label: tf('moveDown'),
        icon: ArrowDown,
        disabled: commands.isLast,
        onSelect: commands.onMoveDown,
      },
      { kind: 'separator', key: 'danger' },
      {
        kind: 'item',
        key: 'delete',
        label: tf('delete'),
        icon: Trash2,
        tone: 'danger',
        onSelect: commands.onDelete,
      },
    );
  }
  entries.push(...extraEntries);

  return (
    <FolderPickerPopover
      open={pickerOpen}
      onOpenChange={onPickerOpenChange}
      anchor={<FolderRowMenu label={tf('actionsAria', { name })} entries={entries} />}
    >
      {pickerOpen ? picker : null}
    </FolderPickerPopover>
  );
}
