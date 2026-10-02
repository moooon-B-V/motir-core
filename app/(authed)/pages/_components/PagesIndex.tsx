import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { NotebookText } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { PageListItemDto } from '@/lib/dto/pages';
import { NewPageButton } from './NewPageButton';

// THE `/pages` INDEX BODY (Story MOTIR-5752 · MOTIR-7300) —
// `design/pages/pages.mock.html` states 2–4, `design-notes.md` § The index.
//
// No `'use client'`: it renders inside the page's server <Suspense> and needs no
// state. `useTranslations` / `useFormatter` work in a Server Component, so the
// same component renders under a test's intl provider.
//
// A FLAT list, newest edit first — the order `pagesService.listPages` returns.
// The page tree, sub-pages and folders are MOTIR-5753's. Each row is ONE link to
// `/pages/<id>`: the glyph, the title (or the untitled copy in italic secondary
// ink, so a blank page is still a findable row) and "Edited <relative time> by
// <name>" — "by you" when the last editor is the reader.
//
// With no pages it is the design system's `EmptyState` (§ State 3): New page as
// the call to action for a reader who may write pages, and NO action at all for
// a viewer, whose description says who writes pages so the empty room does not
// read as broken.

export interface PagesIndexProps {
  pages: PageListItemDto[];
  /** The signed-in reader — a row they edited last reads "by you". */
  viewerId: string;
  /** Whether the reader holds `page:edit` — chooses the empty state's copy. */
  canEdit: boolean;
  /** The instant the relative times are measured from. */
  now: Date;
}

export function PagesIndex({ pages, viewerId, canEdit, now }: PagesIndexProps) {
  const t = useTranslations('pages');
  const format = useFormatter();

  if (pages.length === 0) {
    return (
      <EmptyState
        data-testid="pages-empty"
        icon={<NotebookText className="h-12 w-12" aria-hidden />}
        title={t('index.empty.title')}
        description={canEdit ? t('index.empty.member') : t('index.empty.viewer')}
        action={canEdit ? <NewPageButton /> : undefined}
      />
    );
  }

  return (
    <ul
      aria-label={t('index.listLabel')}
      data-testid="pages-list"
      className="divide-y divide-(--el-border-soft) overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)"
    >
      {pages.map((page) => {
        const time = format.relativeTime(new Date(page.updatedAt), now);
        const edited =
          page.updatedBy.id === viewerId
            ? t('index.editedByYou', { time })
            : t('index.edited', { time, name: page.updatedBy.name });
        return (
          <li key={page.id}>
            <Link
              href={`/pages/${encodeURIComponent(page.id)}`}
              className="flex items-center gap-3 px-(--spacing-card-padding) py-2.5 transition-colors hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-inset"
            >
              <NotebookText
                className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)"
                aria-hidden
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                {page.title ? (
                  <span className="truncate text-sm font-medium text-(--el-text)">
                    {page.title}
                  </span>
                ) : (
                  <span className="truncate text-sm font-medium text-(--el-text-secondary) italic">
                    {t('untitled')}
                  </span>
                )}
                <span className="text-[12.5px] leading-[18px] text-(--el-text-secondary)">
                  {edited}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
