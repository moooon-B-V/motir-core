'use client';

import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';
import { cn } from '@/lib/utils/cn';

// The FOLDER PICKER (Story MOTIR-5308 · MOTIR-5345), the design's panel 4 — built
// ONCE, for two jobs:
//   · `move` — Move to… on a folder row: Project root plus every folder, the
//     folder being moved and everything under it DISABLED with the reason in
//     words;
//   · `file` — the quick view's Folder field (MOTIR-5316): No folder plus every
//     folder, nothing disabled.
// Picking commits (no confirm button); picking the current location writes
// nothing. A refusal the picker could not have known about renders at its top.
//
// `FolderPickerPanel` is presentational — the tree (and the quick view) own the
// read and the write. It is a search field over a WAI-ARIA listbox tracked with
// `aria-activedescendant`, the pattern the design system's Combobox uses; the
// Combobox itself is a trigger-and-dropdown, and the design draws one panel.

/** Per-level indent of a folder option, matching the tree's own 22px. */
const INDENT_PX = 22;

export type FolderPickerMode = 'move' | 'file';

export interface FolderPickerPanelProps {
  mode: FolderPickerMode;
  title: string;
  /** Every folder of the project in tree order, or `null` while it loads. */
  folders: FolderPickerNodeDto[] | null;
  truncated: boolean;
  /** Where the subject sits now: its parent folder (move) or its folder (file); `null` is the root. */
  currentFolderId: string | null;
  /** `move` mode: the folder being moved. */
  movingFolderId?: string;
  /** A refusal from the last write, shown at the top. */
  refusal: string | null;
  pending?: boolean;
  onPick: (folderId: string | null) => void;
  onDismiss: () => void;
}

interface PickerOption {
  key: string;
  folderId: string | null;
  name: string;
  path: string;
  depth: number;
  disabledReason: string | null;
  current: boolean;
}

export function FolderPickerPanel({
  mode,
  title,
  folders,
  truncated,
  currentFolderId,
  movingFolderId,
  refusal,
  pending = false,
  onPick,
  onDismiss,
}: FolderPickerPanelProps) {
  const t = useTranslations('folders');
  const listId = useId();
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const options = useMemo<PickerOption[]>(() => {
    const rootName = mode === 'move' ? t('projectRoot') : t('noFolder');
    const all: PickerOption[] = [
      {
        key: 'root',
        folderId: null,
        name: rootName,
        path: rootName,
        depth: 0,
        disabledReason: null,
        current: currentFolderId === null,
      },
    ];
    const byId = new Map((folders ?? []).map((f) => [f.id, f]));
    const moving = movingFolderId ? byId.get(movingFolderId) : undefined;
    // Whether `folder` sits somewhere under the folder being moved.
    const isInsideMoving = (folder: FolderPickerNodeDto): boolean => {
      let parentId = folder.parentFolderId;
      for (let hops = 0; parentId !== null && hops < 1000; hops += 1) {
        if (parentId === movingFolderId) return true;
        parentId = byId.get(parentId)?.parentFolderId ?? null;
      }
      return false;
    };
    for (const folder of folders ?? []) {
      let disabledReason: string | null = null;
      if (mode === 'move' && movingFolderId) {
        if (folder.id === movingFolderId) disabledReason = t('cannotMoveIntoSelf');
        else if (isInsideMoving(folder))
          disabledReason = t('insideFolder', { name: moving?.name ?? '' });
      }
      all.push({
        key: folder.id,
        folderId: folder.id,
        name: folder.name,
        path: folder.path.join(' ▸ '),
        depth: folder.path.length - 1,
        disabledReason,
        current: currentFolderId === folder.id,
      });
    }
    const q = query.trim().toLowerCase();
    return q ? all.filter((o) => o.path.toLowerCase().includes(q)) : all;
  }, [folders, mode, movingFolderId, currentFolderId, query, t]);

  const searching = query.trim().length > 0;
  const enabled = options.filter((o) => o.disabledReason === null);
  const active = enabled.find((o) => o.key === activeKey) ?? enabled[0] ?? null;
  const optionId = (key: string) => `${listId}-${key}`;

  const choose = (option: PickerOption) => {
    if (option.disabledReason !== null || pending) return;
    if (option.current) onDismiss();
    else onPick(option.folderId);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // The panel sits inside the treegrid's React tree; its row keys must not see these.
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabled.length === 0) return;
      const at = active ? enabled.indexOf(active) : -1;
      const next =
        e.key === 'ArrowDown'
          ? (at + 1) % enabled.length
          : (at - 1 + enabled.length) % enabled.length;
      setActiveKey(enabled[next]!.key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-2.5 pt-2 pb-1.5 text-xs font-semibold text-(--el-text-secondary)">
        {title}
      </div>
      {refusal ? (
        <div
          role="alert"
          className="mx-1 mt-0.5 mb-1.5 flex items-start gap-1.5 rounded-(--radius-control) border border-(--el-danger) bg-(--el-tint-rose) px-2.5 py-2 text-xs text-(--el-text-strong)"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
          <span>{refusal}</span>
        </div>
      ) : null}
      <Input
        role="combobox"
        aria-label={t('pickerSearch')}
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active.key) : undefined}
        placeholder={t('pickerSearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
      />
      {folders === null ? (
        <div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-(--el-text-secondary)">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t('pickerLoading')}
        </div>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={t('pickerListLabel')}
          className="mt-1 max-h-72 overflow-y-auto"
        >
          {options.map((option) => {
            const disabled = option.disabledReason !== null;
            return (
              <div
                key={option.key}
                id={optionId(option.key)}
                role="option"
                aria-selected={option.current}
                aria-disabled={disabled || undefined}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => {
                  if (!disabled) setActiveKey(option.key);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(option);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') choose(option);
                }}
                style={
                  searching
                    ? undefined
                    : {
                        paddingLeft: `calc(var(--spacing-control-x) + ${option.depth * INDENT_PX}px)`,
                      }
                }
                className={cn(
                  'flex w-full items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13px]',
                  disabled
                    ? 'cursor-default text-(--el-text-faint)'
                    : 'cursor-pointer text-(--el-text)',
                  active?.key === option.key && 'bg-(--el-surface)',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate">{searching ? option.path : option.name}</span>
                  {option.disabledReason ? (
                    <span className="text-[11.5px] text-(--el-text-secondary)">
                      {option.disabledReason}
                    </span>
                  ) : null}
                </span>
                {option.current ? (
                  <span className="ml-auto shrink-0 text-[11.5px] text-(--el-text-secondary)">
                    {t('currentLocation')}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {truncated && folders !== null ? (
        <p className="px-2.5 py-1.5 text-xs text-(--el-text-secondary)">
          {t('pickerTruncated', { count: folders.length })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The picker anchored to a tree row — the actions button it was opened from is
 * the anchor, so the panel opens where the person was looking. Events stop at
 * the panel: it lives inside the treegrid row's React tree.
 */
export function FolderPickerPopover({
  open,
  onOpenChange,
  anchor,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>
        <span className="relative z-10 ml-auto inline-flex">{anchor}</span>
      </Popover.Anchor>
      <Popover.Content
        width={320}
        align="end"
        className="p-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </Popover.Content>
    </Popover>
  );
}
