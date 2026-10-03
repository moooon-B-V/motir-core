'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { Archive, ArrowRight, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DeletePageDialog } from './DeletePageDialog';
import { useRestorePage } from './useRestorePage';

// THE ARCHIVED PAGE'S BANNER (Story MOTIR-5755 · MOTIR-7423) — design MOTIR-7416,
// surface 5. An archived page still opens at its address, read-only for
// everyone, under this banner between the breadcrumb and the title row. It is
// the `ArchivedNotice` grammar (`components/issues/ArchivedNotice.tsx`): neutral
// `--el-surface-soft`, a `--el-border` hairline, `--radius-card` and the Archive
// glyph — state in words, never hue. Nothing is wrong with the page.
//
// ── TWO VARIANTS ───────────────────────────────────────────────────────────
// • The ARCHIVE ROOT: "This page is archived", who and when, how many sub-pages
//   went with it, and — for an editor — "Restore it to bring it back where it
//   was." Actions by role: a viewer none; a member **Restore**; a manager
//   **Restore** and **Delete…** (`--el-danger-on-surface`, never the fill ink).
// • A SUB-PAGE that left with its root: "This page was archived with “{root}”",
//   and its one action is **Open “{root}”** — restore and delete act on the root
//   only (`PAGE_ARCHIVE_ROOT_REQUIRED`).
//
// ── WHAT A WRITE DOES TO THE PAGE ──────────────────────────────────────────
// Restore re-reads the page (`router.refresh()`): the banner goes, the editor
// becomes editable, and the page route re-keys its sidebar tree on the archive
// state so the client island reads the live tree again. Delete… opens the
// permanent-delete confirm; once it answers, the page no longer exists, so the
// browser goes to `/pages` with the toast.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedPageInfo {
  id: string;
  /** As the page shows it (Untitled already resolved). */
  title: string;
  /** ISO-8601. */
  archivedAt: string;
  archivedBy: { name: string } | null;
  archiveRoot: { id: string; title: string } | null;
  canRestore: boolean;
  canDelete: boolean;
}

export interface PageArchivedBannerProps {
  page: ArchivedPageInfo;
  /** The sub-pages archived with it (a root's set minus itself). */
  subPageCount: number;
  /** Its parent's title at archive time, for the restored-elsewhere reason. */
  parentTitle?: string | null;
}

const bold = (chunks: ReactNode) => <span className="font-medium text-(--el-text)">{chunks}</span>;

/** Relative under a day, absolute after — the History panel's rule for a time. */
function useArchivedAtLabel(iso: string): string {
  const format = useFormatter();
  const now = useNow();
  const date = new Date(iso);
  return now.getTime() - date.getTime() < DAY_MS
    ? format.relativeTime(date, now)
    : format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PageArchivedBanner({ page, subPageCount, parentTitle }: PageArchivedBannerProps) {
  const t = useTranslations('pages.archive');
  const tp = useTranslations('pages');
  const ti = useTranslations('issueViews');
  const router = useRouter();
  const { pendingId, restore } = useRestorePage();
  const [deleting, setDeleting] = useState(false);
  const date = useArchivedAtLabel(page.archivedAt);
  const name = page.archivedBy?.name || ti('archivedByUnknownActor');
  const isRoot = page.archiveRoot === null || page.archiveRoot.id === page.id;
  const root = page.archiveRoot && !isRoot ? page.archiveRoot : null;
  const rootTitle = root ? root.title || tp('untitled') : '';
  const restoring = pendingId === page.id;
  const headingId = `page-archived-banner-${page.id}`;

  const onRestore = async () => {
    const outcome = await restore({ id: page.id, title: page.title, parentTitle });
    // Restored here or already by someone else: either way the page is live.
    if (outcome && (outcome.ok || outcome.kind === 'notArchived')) router.refresh();
  };

  let actions: ReactNode = null;
  if (root) {
    actions = (
      <Link
        href={`/pages/${encodeURIComponent(root.id)}`}
        className="inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-btn) border border-(--el-button-border) px-(--spacing-btn-x-sm) text-xs font-medium text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {t('openRoot', { root: rootTitle })}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    );
  } else if (page.canRestore || page.canDelete) {
    actions = (
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {page.canRestore ? (
          <Button
            variant="secondary"
            size="sm"
            loading={restoring}
            leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            aria-label={restoring ? undefined : t('restoreLabel', { title: page.title })}
            onClick={() => void onRestore()}
          >
            {restoring ? t('restoring') : t('restore')}
          </Button>
        ) : null}
        {page.canDelete ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={restoring}
            leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            className="border-(--el-border) text-(--el-danger-on-surface)"
            onClick={() => setDeleting(true)}
          >
            {t('delete.menuItem')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div
        role="status"
        aria-labelledby={headingId}
        data-testid="page-archived-banner"
        className="flex flex-wrap items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-3.5 py-3"
      >
        <Archive
          className="mt-0.5 h-[18px] w-[18px] shrink-0 text-(--el-text-secondary)"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={headingId} className="text-sm font-semibold text-(--el-text)">
            {root ? t('banner.subTitle', { root: rootTitle }) : t('banner.title')}
          </span>
          <span className="text-[13px] text-(--el-text-secondary)">
            {root
              ? t.rich('banner.subMeta', { name, date, root: rootTitle, b: bold })
              : t.rich('banner.meta', { name, date, b: bold })}
            {!root && subPageCount > 0 ? (
              <> {t('banner.withSubPages', { count: subPageCount })}</>
            ) : null}
            {!root && page.canRestore ? <> {t('banner.restoreHint')}</> : null}
          </span>
        </div>
        {actions}
      </div>
      {deleting ? (
        <DeletePageDialog
          page={{ id: page.id, title: page.title }}
          subPageCount={subPageCount}
          onClose={() => setDeleting(false)}
          onDeleted={() => router.push('/pages')}
          onStale={() => router.refresh()}
        />
      ) : null}
    </>
  );
}
