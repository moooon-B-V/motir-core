'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive, ArrowLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Avatar, StatusValue } from '../../_components/issueCellPrimitives';
import { IssueListPager } from '../../_components/IssueListPager';
import {
  unarchiveWorkItem,
  WorkItemActionError,
} from '@/components/issues/actions/workItemActionsClient';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { cn } from '@/lib/utils/cn';
import { ArchivedRowDeleteMenu } from './ArchivedRowDeleteMenu';
import type { ArchivedRowData } from './archivedRows';

// The archived work items view (Story 2.9 · Subtask 2.9.3), per
// design/work-items/archived.mock.html + design-notes "Archived work items view
// + Restore UX". A flat, server-paged list (NOT a tree — archive is single-node)
// reusing the active List's container chrome, row vocabulary (IssueTypeIcon ·
// mono id · title · status Pill · initial Avatar), and IssueListPager footer.
//
// It is a CLIENT ISLAND so Restore + Delete remove the row optimistically: per
// the page-state-after-mutation contract, the success response IS the
// confirmation, so on the unarchive / delete 200 we drop the row LOCALLY (no
// router.refresh) and decrement the pager total — a restored item reappears in
// the active /items + board views, and a deleted subtree disappears from them,
// on their next (separate server-read) navigation.
//
// The actions cell is TOTAL over the two independent capabilities (Subtask
// 2.9.5, design-notes §2.9.7), each affordance HIDDEN — never shown-disabled —
// when its gate is unmet (the WorkItemActionsMenu pattern):
//   • Restore — the prominent inline `[Restore]` button, gated `canEdit`.
//   • Delete  — a danger `Delete…` row inside a per-row `⋯` overflow menu, gated
//     `canManage` (read from `useProjectAccess()`, not a server prop — the
//     `WorkItemRowActions` pattern). The `⋯` is PURELY the Delete affordance.
// When NEITHER gate is met the whole actions column is dropped (the view-only
// state). `canManage` comes from the provider mounted in the authed layout.
//
// Pagination is URL-driven (?page=) so the Server Component re-reads each page;
// the parent keys this island by page, so the optimistic-removed set resets on
// navigation.

export interface ArchivedWorkItemsListProps {
  /** The current page's archived rows (already shaped + status-resolved). */
  rows: ArchivedRowData[];
  /** Total archived count across all pages (the pager denominator). */
  total: number;
  /** The active 1-based page (already clamped by the service). */
  page: number;
  /** The fixed page size. */
  pageSize: number;
  /** Whether the viewer may restore — drops the action column when false. */
  canEdit: boolean;
}

const COL_HEADER =
  'flex min-w-0 items-center text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase';

export function ArchivedWorkItemsList({
  rows,
  total,
  page,
  pageSize,
  canEdit,
}: ArchivedWorkItemsListProps) {
  const t = useTranslations('issueViews');
  const ta = useTranslations('workItemActions');
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  // Delete is project-admin (canManage) — the same gate the server enforces
  // (`deleteWorkItem`/`getDeletePreview` → `assertCanManage`). Read from the
  // provider mounted in the authed layout (the WorkItemRowActions pattern), so
  // no new server prop has to thread through the page.
  const { canManage } = useProjectAccess();

  // Optimistic removal: the ids removed (restored OR deleted) this page + the
  // ids whose unarchive POST is in flight (the row fades + locks). Adding to a
  // Set is monotonic, so out-of-order restore/delete completions never clobber
  // each other (no seq counter needed). Both reset when the parent remounts the
  // island on a page change (keyed by `page`).
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());

  // Delete success — the ArchivedRowDeleteMenu's dialog already ran the DELETE +
  // showed the `{key} deleted` toast; here we just drop the row locally (which
  // also decrements `effectiveTotal`, the pager denominator). Same removal set
  // as Restore.
  const onDeleted = useCallback((id: string) => {
    setRemovedIds((prev) => new Set(prev).add(id));
  }, []);

  const onPage = useCallback(
    (next: number) => {
      router.push(next <= 1 ? pathname : `${pathname}?page=${next}`);
    },
    [router, pathname],
  );

  const onRestore = useCallback(
    async (row: ArchivedRowData) => {
      setPendingIds((prev) => new Set(prev).add(row.id));
      try {
        await unarchiveWorkItem(row.id);
        setRemovedIds((prev) => new Set(prev).add(row.id));
        toast({ variant: 'success', title: ta('restoredToast', { key: row.identifier }) });
      } catch (err) {
        void (err instanceof WorkItemActionError);
        toast({
          variant: 'error',
          title: ta('restoreErrorTitle'),
          description: ta('archiveErrorBody'),
        });
      } finally {
        setPendingIds((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(row.id);
          return nextSet;
        });
      }
    },
    [toast, ta],
  );

  // The whole archive is empty (not merely emptied optimistically on this page).
  if (total === 0) {
    return (
      <EmptyState
        icon={<Archive className="h-12 w-12" aria-hidden />}
        title={t('archivedEmptyTitle')}
        description={t('archivedEmptyDescription')}
        action={
          <Button
            variant="secondary"
            leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden />}
            onClick={() => router.push('/items')}
          >
            {t('archivedEmptyAction')}
          </Button>
        }
      />
    );
  }

  const visibleRows = rows.filter((r) => !removedIds.has(r.id));
  const effectiveTotal = Math.max(0, total - removedIds.size);
  // The actions column shows when EITHER capability is present; it's dropped only
  // when neither Restore nor Delete is available (the view-only state).
  const showActions = canEdit || canManage;
  // Grid: Title · Status · Archived by · Archived (· actions when showActions).
  // The actions track is 150px (was 120px) to seat `[Restore]` + `⋯` together.
  const gridTemplate = showActions
    ? 'minmax(0,1fr) 130px 175px 140px 150px'
    : 'minmax(0,1fr) 130px 175px 140px';

  return (
    <div>
      <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
        <div role="table" aria-label={t('archivedHeading')} className="w-full text-sm">
          {/* Header */}
          <div role="rowgroup">
            <div
              role="row"
              className="grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-5 pl-4"
              style={{ gridTemplateColumns: gridTemplate, height: 40 }}
            >
              <div role="columnheader" className={COL_HEADER}>
                <span className="truncate">{t('colTitle')}</span>
              </div>
              <div role="columnheader" className={COL_HEADER}>
                <span className="truncate">{t('colStatus')}</span>
              </div>
              <div role="columnheader" className={COL_HEADER}>
                <span className="truncate">{t('archivedColArchivedBy')}</span>
              </div>
              <div role="columnheader" className={COL_HEADER}>
                <span className="truncate">{t('archivedColArchived')}</span>
              </div>
              {showActions ? (
                <div role="columnheader" className={cn(COL_HEADER, 'justify-end')}>
                  <span className="sr-only">{t('archivedColActions')}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Body */}
          <div role="rowgroup">
            {visibleRows.map((row) => {
              const restoring = pendingIds.has(row.id);
              return (
                <div
                  key={row.identifier}
                  role="row"
                  data-testid={`archived-row-${row.identifier}`}
                  aria-busy={restoring || undefined}
                  className={cn(
                    'group relative grid items-center gap-x-4 border-b border-(--el-border) pr-5 pl-4 last:border-b-0 hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
                    restoring && 'pointer-events-none opacity-45',
                  )}
                  style={{ gridTemplateColumns: gridTemplate, height: 48 }}
                >
                  {/* Title — the stretched link lives INSIDE the first cell so a
                      role="row" has only cell children (aria-required-children);
                      the cell is static, so absolute inset-0 covers the row. */}
                  <div role="cell" className="flex min-w-0 items-center gap-2">
                    <Link
                      href={`/items/${row.identifier}`}
                      aria-label={`${row.identifier} ${row.title}`}
                      className="absolute inset-0 z-0 focus:outline-none"
                    />
                    <IssueTypeIcon type={row.kind} className="h-4 w-4 shrink-0" />
                    <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">
                      {row.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-(--el-text) group-hover:underline">
                      {row.title}
                    </span>
                  </div>

                  <div role="cell" className="flex min-w-0 items-center">
                    <StatusValue category={row.statusCategory} label={row.statusLabel} />
                  </div>

                  <div role="cell" className="flex min-w-0 items-center">
                    {row.archivedByName ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar name={row.archivedByName} />
                        <span className="truncate text-(--el-text-secondary)">
                          {row.archivedByName}
                        </span>
                      </span>
                    ) : (
                      <span className="text-(--el-text-muted)">—</span>
                    )}
                  </div>

                  <div role="cell" className="flex min-w-0 items-center">
                    <span className="truncate text-(--el-text-secondary)">
                      {row.archivedAtLabel}
                    </span>
                  </div>

                  {showActions ? (
                    <div role="cell" className="relative z-10 flex items-center justify-end gap-1">
                      {canEdit ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={restoring}
                          leftIcon={
                            restoring ? undefined : (
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                            )
                          }
                          aria-label={t('archivedRestoreAria', { key: row.identifier })}
                          onClick={() => void onRestore(row)}
                        >
                          {restoring ? t('archivedRestoring') : t('archivedRestore')}
                        </Button>
                      ) : null}
                      {canManage ? (
                        <ArchivedRowDeleteMenu
                          itemId={row.id}
                          identifier={row.identifier}
                          title={row.title}
                          onDeleted={() => onDeleted(row.id)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <IssueListPager total={effectiveTotal} page={page} pageSize={pageSize} onPage={onPage} />
      </div>
    </div>
  );
}
