'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FolderPickerNodeDto, ProjectFoldersDto } from '@/lib/dto/folders';
import { listProjectFoldersAction } from '../actions';
import { FolderPickerPanel } from './FolderPicker';

// The quick view's FOLDER field control (Story MOTIR-5308 · MOTIR-5316), the
// design's panel 6 — the folder picker in `file` mode, in flow inside the rail,
// with the one line that matters before a filing: an item sits under a work item
// OR in a folder, never both, so filing an item that has a parent takes it out
// of that parent, and the field says so before anything is saved.
//
// Presentational over its one read: it loads the project's folders when it opens
// and hands the pick back. The write, the optimistic value and the placement
// report are the panel's, through the rail's own commit path.

export interface QuickViewFolderControlProps {
  /** The item's current folder; `null` when it is not filed. */
  folderId: string | null;
  /** The item's work-item parent, when it has one — filing will clear it. */
  parent: { identifier: string; title: string } | null;
  /** A folder (or `null` for No folder) was picked; `path` is its names, root first. */
  onPick: (folderId: string | null, path: string[]) => void;
  onDismiss: () => void;
}

export function QuickViewFolderControl({
  folderId,
  parent,
  onPick,
  onDismiss,
}: QuickViewFolderControlProps) {
  const t = useTranslations('folders');
  const [loaded, setLoaded] = useState<ProjectFoldersDto | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listProjectFoldersAction()
      .then((res) => {
        if (!alive) return;
        if (res.ok) setLoaded(res.data);
        else {
          setLoaded({ folders: [], truncated: false });
          setRefusal(res.error);
        }
      })
      .catch(() => {
        if (!alive) return;
        setLoaded({ folders: [], truncated: false });
        setRefusal(t('fileRefused'));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  /* v8 ignore next 4 -- the two `?? []` fallbacks are UNREACHABLE: the panel's
     options are the root (`null`, answered by the first arm) plus one per
     loaded folder, and it hands back only an option's own id — so a non-null id
     is always in `loaded.folders`. Asserted by folder-ui-coverage.test.tsx ›
     'every folder the field offers hands back its full path'. */
  const pathOf = (id: string | null): string[] =>
    id === null
      ? []
      : ((loaded?.folders ?? []).find((f: FolderPickerNodeDto) => f.id === id)?.path ?? []);

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {parent ? (
        <p className="text-[11.5px] leading-relaxed text-(--el-text-secondary)">
          {t('removesFromParent', { key: parent.identifier, title: parent.title })}
        </p>
      ) : null}
      <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-1">
        <FolderPickerPanel
          mode="file"
          title={t('fieldLabel')}
          folders={loaded?.folders ?? null}
          truncated={loaded?.truncated ?? false}
          currentFolderId={folderId}
          refusal={refusal}
          onPick={(id) => onPick(id, pathOf(id))}
          onDismiss={onDismiss}
        />
      </div>
    </div>
  );
}
