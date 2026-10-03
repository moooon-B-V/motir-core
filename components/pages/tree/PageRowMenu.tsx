'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, FolderInput, Plus } from 'lucide-react';
import { FolderPickerPopover } from '@/components/folders/FolderPicker';
import { FolderRowMenu, type FolderMenuEntry } from '@/components/folders/FolderRowMenu';

// A PAGE ROW's menu (Story MOTIR-5753 · MOTIR-7373 / MOTIR-7374) —
// `design/pages/pages--tree.mock.html` panel 2, `design-notes.md` § The page
// tree, "Row menus": **New sub-page · Move to… | Move up · Move down**, in the
// shared `FolderRowMenu` grammar so a page row's menu and a folder row's read as
// one family.
//
// Move up / Move down reorder among SIBLING PAGES only — folders always lead a
// level, so a page never passes one. On the first sibling **Move up is
// ABSENT**, on the last **Move down is absent** (MOTIR-7374's acceptance; the
// design's open question records that folder rows draw theirs DISABLED instead,
// as shipped, and the approved design keeps both). The separator is drawn only
// when one of the two remains.
//
// The menu is also the ANCHOR of the Move to… picker (`PagePlacementPicker`),
// exactly as `/items` anchors its folder picker to the row's actions button, so
// the panel opens where the person was looking.

export interface PageRowMenuProps {
  /** The page's title as the row shows it (Untitled resolved) — the menu's label. */
  title: string;
  onNewSubPage: () => void;
  onMoveTo: () => void;
  /** Omitted on the first sibling page: the entry is absent. */
  onMoveUp?: () => void;
  /** Omitted on the last sibling page: the entry is absent. */
  onMoveDown?: () => void;
  /** Entries a later card appends after the card's own (the `pageMenuEntries` seam). */
  extraEntries?: FolderMenuEntry[];
  /** Whether the Move to… picker is open, anchored to this menu. */
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  /** The picker panel, rendered while it is open. */
  picker: ReactNode;
}

export function PageRowMenu({
  title,
  onNewSubPage,
  onMoveTo,
  onMoveUp,
  onMoveDown,
  extraEntries = [],
  pickerOpen,
  onPickerOpenChange,
  picker,
}: PageRowMenuProps) {
  const t = useTranslations('pages.tree');
  const tf = useTranslations('folders');
  const entries: FolderMenuEntry[] = [
    {
      kind: 'item',
      key: 'new-sub-page',
      label: t('newSubPage'),
      icon: Plus,
      onSelect: onNewSubPage,
    },
    { kind: 'item', key: 'move-to', label: tf('moveTo'), icon: FolderInput, onSelect: onMoveTo },
  ];
  if (onMoveUp || onMoveDown) entries.push({ kind: 'separator', key: 'order' });
  if (onMoveUp) {
    entries.push({
      kind: 'item',
      key: 'move-up',
      label: tf('moveUp'),
      icon: ArrowUp,
      onSelect: onMoveUp,
    });
  }
  if (onMoveDown) {
    entries.push({
      kind: 'item',
      key: 'move-down',
      label: tf('moveDown'),
      icon: ArrowDown,
      onSelect: onMoveDown,
    });
  }
  entries.push(...extraEntries);

  return (
    <FolderPickerPopover
      open={pickerOpen}
      onOpenChange={onPickerOpenChange}
      anchor={<FolderRowMenu label={t('pageActionsAria', { title })} entries={entries} />}
    >
      {pickerOpen ? picker : null}
    </FolderPickerPopover>
  );
}
