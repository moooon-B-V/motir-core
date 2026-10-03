import { useTranslations } from 'next-intl';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

// THE ARCHIVED PAGES LIST'S PENDING FRAME (Story MOTIR-5755 · MOTIR-7424) —
// design MOTIR-7416, surface 6 "loading": the table's header row painted, then
// four row blocks in `--el-muted`. The page's in-page <Suspense> fallback, after
// the gate; never a `loading.tsx`. Rows are the list's own box (56px) under the
// same grid, so the list settles with no shift. `PageSkeleton` announces the wait.

/** The table's columns: Page · Came from · Archived by · Archived (· actions). */
export function archivedPagesGrid(showActions: boolean): string {
  return showActions
    ? 'minmax(0,1.3fr) minmax(0,1fr) 160px 150px 150px'
    : 'minmax(0,1.3fr) minmax(0,1fr) 160px 150px';
}

export const ARCHIVED_COL_HEADER =
  'flex min-w-0 items-center text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase';

const TITLE_WIDTHS = ['w-[160px]', 'w-[120px]', 'w-[190px]', 'w-[140px]'];

export function ArchivedPagesHeaderRow({ showActions }: { showActions: boolean }) {
  const t = useTranslations('pages.archive.list.col');
  return (
    <div role="rowgroup">
      <div
        role="row"
        className="grid h-10 items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-5 pl-4"
        style={{ gridTemplateColumns: archivedPagesGrid(showActions) }}
      >
        <div role="columnheader" className={ARCHIVED_COL_HEADER}>
          <span className="truncate">{t('page')}</span>
        </div>
        <div role="columnheader" className={ARCHIVED_COL_HEADER}>
          <span className="truncate">{t('cameFrom')}</span>
        </div>
        <div role="columnheader" className={ARCHIVED_COL_HEADER}>
          <span className="truncate">{t('archivedBy')}</span>
        </div>
        <div role="columnheader" className={ARCHIVED_COL_HEADER}>
          <span className="truncate">{t('archivedAt')}</span>
        </div>
        {showActions ? (
          <div role="columnheader" className={ARCHIVED_COL_HEADER}>
            <span className="sr-only">{t('actions')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ArchivedPagesFrame({ showActions }: { showActions: boolean }) {
  const t = useTranslations('pages.archive.list');
  return (
    <PageSkeleton header={false}>
      <div
        role="table"
        aria-label={t('title')}
        data-testid="archived-pages-frame"
        className="overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)"
      >
        <ArchivedPagesHeaderRow showActions={showActions} />
        <div className="divide-y divide-(--el-border-soft)">
          {TITLE_WIDTHS.map((width) => (
            <div key={width} className="flex h-14 items-center gap-2 pr-5 pl-4">
              <div className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
              <div className={`h-3 ${width} rounded-(--radius-control) bg-(--el-muted)`} />
            </div>
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}
