import { Fragment } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Folder } from 'lucide-react';
import type { PlacementFolderDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The parent breadcrumb on the issue detail page (Story 2.4 · Subtask 2.4.3),
// per the mockup `design/work-items/detail.png`: the eyebrow row reads
// `[type] PROD-N · [type] Epic: <title>` — the current item's identifier
// (rendered by 2.4.1's header) followed by its ANCESTOR chain. This component
// renders only the chain (the `· [icon] <Type>: <title>` segments) so it slots
// in right after the identifier. Ancestors arrive ordered root→self, so the
// epic reads first and the immediate parent last, matching the lineage a nested
// subtask (Subtask → Task → Story → Epic) walks up to.
//
// A filed item's EFFECTIVE folder leads the chain (Story MOTIR-5309 ·
// MOTIR-5381, design/work-items/placement.mock.html panel 4): ONE segment, the
// path joined with `▸`, before the ancestors. It is TEXT, not a link — nothing in
// the product takes a reader to a folder — with the folder glyph, a visually-hidden
// "Folder:" prefix, and the full path in its `title` for when it truncates. The
// landmark is named by its content: "Folder and parent work items" when a folder
// segment is present, the shipped "Parent work items" otherwise.
//
// An unfiled top-level item has no segments → renders nothing (the AC's "no
// breadcrumb" case); a FILED root now renders its folder. Each work-item segment
// is a plain `next/link` to that ancestor's own detail page (`/items/[key]`), so
// the chain is keyboard-navigable as a sequence of links.

export function ParentBreadcrumb({
  ancestors,
  placementFolder = null,
}: {
  ancestors: WorkItemSummaryDto[];
  placementFolder?: PlacementFolderDto | null;
}) {
  const t = useTranslations('issueViews');
  const tf = useTranslations('folders');
  if (ancestors.length === 0 && placementFolder === null) return null;
  const folderPath = placementFolder ? placementFolder.path.join(' ▸ ') : null;

  return (
    <nav
      aria-label={folderPath !== null ? t('placementBreadcrumbAria') : t('parentIssuesAria')}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      {folderPath !== null ? (
        <>
          <span className="text-(--el-text-secondary)" aria-hidden>
            ·
          </span>
          <span
            className="flex min-w-0 max-w-full items-center gap-1 font-sans text-sm text-(--el-text-secondary)"
            title={folderPath}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{tf('breadcrumbFolderLabel')}</span>
            <span className="truncate">{folderPath}</span>
          </span>
        </>
      ) : null}
      {ancestors.map((ancestor) => {
        const meta = ISSUE_TYPE_META[ancestor.kind];
        return (
          <Fragment key={ancestor.id}>
            <span className="text-(--el-text-secondary)" aria-hidden>
              ·
            </span>
            <Link
              href={`/items/${ancestor.identifier}`}
              className="text-(--el-text-muted) hover:text-(--el-text) flex min-w-0 items-center gap-1 rounded-(--radius-control) font-sans text-sm hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <IssueTypeIcon type={ancestor.kind} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {meta.label}: {ancestor.title}
              </span>
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
