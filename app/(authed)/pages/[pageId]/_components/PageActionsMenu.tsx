'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive } from 'lucide-react';
import { FolderRowMenu } from '@/components/folders/FolderRowMenu';
import { ArchivePageDialog } from '@/components/pages/archive/ArchivePageDialog';
import { useArchivePage } from '@/components/pages/archive/useArchivePage';

// THE PAGE'S OWN ⋯ (Story MOTIR-5755 · MOTIR-7423) — design MOTIR-7416, surface
// 2. The title row's trailing end, after History: a `Button` secondary sm square
// holding `Ellipsis`, labelled "Page actions for {title}", opening a menu in the
// `FolderRowMenu` grammar. It holds **Archive…** alone today and is where later
// page actions go. Rendered only for a reader who may write the page — a viewer
// would find nothing in it — and never on an archived page, whose banner
// carries its actions.
//
// It is the door on the page route: the route's sidebar tree is navigation only
// (MOTIR-7375's approved design), so it carries no row menu.
//
// Archiving from here does NOT navigate: the page re-reads itself
// (`router.refresh()`) and shows the archived banner, and the same toast with
// Undo appears; Undo re-reads it back to live.

export interface PageActionsMenuProps {
  page: { id: string; title: string };
  /** The page's parent's title, for Undo's restored-elsewhere reason. */
  parentTitle?: string | null;
}

export function PageActionsMenu({ page, parentTitle }: PageActionsMenuProps) {
  const t = useTranslations('pages.archive');
  const router = useRouter();
  const archive = useArchivePage({
    onArchived: () => router.refresh(),
    onRestored: () => router.refresh(),
    onStale: () => router.refresh(),
  });

  return (
    <>
      <FolderRowMenu
        trigger="button"
        label={t('pageActions', { title: page.title })}
        entries={[
          {
            kind: 'item',
            key: 'archive',
            label: t('menuItem'),
            icon: Archive,
            disabled: archive.pendingId !== null,
            onSelect: () => archive.request({ id: page.id, title: page.title, parentTitle }),
          },
        ]}
      />
      {archive.confirm ? <ArchivePageDialog {...archive.confirm} /> : null}
    </>
  );
}
