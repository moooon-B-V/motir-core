'use client';

import { Fragment, useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  NotebookText,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { FolderRowMenu } from '@/components/folders/FolderRowMenu';
import { DeletePageDialog } from '@/components/pages/archive/DeletePageDialog';
import { useArchivedAtLabel } from '@/components/pages/archive/useArchivedAtLabel';
import { useRestorePage } from '@/components/pages/archive/useRestorePage';
import type { PageArchivedListDto, PageArchivedListItemDto } from '@/lib/dto/pages';
import { cn } from '@/lib/utils/cn';
import { ArchivedPagesHeaderRow, archivedPagesGrid } from './ArchivedPagesFrame';

// THE ARCHIVED PAGES TABLE (Story MOTIR-5755 · MOTIR-7424) — design MOTIR-7416,
// surfaces 6–9 on the list: `ArchivedWorkItemsList`'s grammar (a `role="table"`
// in a card frame, a header row on `--el-surface-soft`), a row per archive ROOT
// with where it came from, Restore and a ⋯ holding Delete….
//
// ── A CLIENT ISLAND ────────────────────────────────────────────────────────
// Seeded once from the server's first page; every write answers in place. Per
// the page-state contract the write's answer IS the confirmation, so a restored
// or deleted row is dropped LOCALLY — no `router.refresh()`, which could not
// reach this island's state anyway. The tree the page returns to is read fresh
// on its next visit.
//
// ── PAGING ─────────────────────────────────────────────────────────────────
// The tree level's keyset contract: 50 a page, **Load more** with the cursor the
// last read returned, appended without duplicates (a row restored meanwhile on
// another tab can shift a boundary). A failed read — the first, when the server
// could not read it, or a later one — is one error row with **Try again**, which
// repeats that same read; the rows above it stay.
//
// ── RESTORE AND DELETE, AND THE STALE ROW ──────────────────────────────────
// Restore goes through `useRestorePage` with **Open** on its toasts (the landing
// decides the toast: original → success; elsewhere → the reason). Delete… opens
// `DeletePageDialog`. A row that went stale in another tab says so and LEAVES:
// restored already (`PAGE_NOT_ARCHIVED`, from Restore or Delete…), or archived
// again inside its parent's archive (`PAGE_ARCHIVE_ROOT_REQUIRED`, whose toast
// offers the root). A row mid-action is `aria-busy` and inert; the others stay
// live.

const PAGE_SIZE = 50;

export interface ArchivedPagesListProps {
  /** The first page as the server read it, or `null` when it could not be read. */
  initial: PageArchivedListDto | null;
  projectKey: string;
  /** `page:edit` — Restore. */
  canRestore: boolean;
  /** `page:delete` — Delete…. */
  canDelete: boolean;
}

async function readArchived(
  projectKey: string,
  cursor: string | null,
): Promise<PageArchivedListDto> {
  const query = new URLSearchParams({ projectKey, limit: String(PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  const res = await fetch(`/api/pages/archived?${query.toString()}`);
  if (!res.ok) throw new Error(`GET /api/pages/archived answered ${res.status}`);
  return (await res.json()) as PageArchivedListDto;
}

export function ArchivedPagesList({
  initial,
  projectKey,
  canRestore,
  canDelete,
}: ArchivedPagesListProps) {
  const t = useTranslations('pages.archive');
  const tp = useTranslations('pages');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const { pendingId, restore } = useRestorePage({ showOpen: true });
  const [items, setItems] = useState<PageArchivedListItemDto[]>(initial?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initial?.nextCursor ?? null);
  // `failedAt`: the cursor of the read that failed — `null` is the first page.
  const [failedAt, setFailedAt] = useState<{ cursor: string | null } | null>(
    initial ? null : { cursor: null },
  );
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<PageArchivedListItemDto | null>(null);
  const reading = useRef(false);
  const showActions = canRestore || canDelete;

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const staleToast = useCallback(
    (title: string) =>
      toast({
        variant: 'error',
        title: t('refusal.notArchivedList', { title }),
        description: t('refusal.notArchivedListBody'),
      }),
    [t, toast],
  );

  const load = useCallback(
    async (cursor: string | null) => {
      if (reading.current) return;
      reading.current = true;
      setLoading(true);
      setFailedAt(null);
      try {
        const page = await readArchived(projectKey, cursor);
        setItems((prev) => {
          const base = cursor === null ? [] : prev;
          const seen = new Set(base.map((item) => item.id));
          return [...base, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setNextCursor(page.nextCursor);
      } catch {
        setFailedAt({ cursor });
      } finally {
        reading.current = false;
        setLoading(false);
      }
    },
    [projectKey],
  );

  const titleOf = (item: PageArchivedListItemDto) => item.title || tp('untitled');

  const onRestore = async (item: PageArchivedListItemDto) => {
    const title = titleOf(item);
    const outcome = await restore({
      id: item.id,
      title,
      parentTitle: item.cameFrom.pages.at(-1)?.title ?? null,
    });
    if (!outcome) return;
    if (outcome.ok) {
      remove(item.id);
      return;
    }
    if (outcome.kind === 'notArchived') staleToast(title);
    // Restored elsewhere, archived again under its parent, or gone: the row is stale.
    if (outcome.kind !== 'failed' && outcome.kind !== 'alreadyArchived') remove(item.id);
  };

  if (items.length === 0 && nextCursor === null && failedAt === null && !loading) {
    return (
      <EmptyState
        icon={<Archive className="h-10 w-10" aria-hidden />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button
            variant="secondary"
            leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden />}
            onClick={() => router.push('/pages')}
          >
            {t('list.back')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)">
        <div role="table" aria-label={t('list.title')} className="w-full text-sm">
          <ArchivedPagesHeaderRow showActions={showActions} />
          <div role="rowgroup">
            {items.map((item) => (
              <ArchivedPageRow
                key={item.id}
                item={item}
                title={titleOf(item)}
                showActions={showActions}
                canRestore={canRestore}
                canDelete={canDelete}
                restoring={pendingId === item.id}
                deleting={deleting?.id === item.id}
                onRestore={() => void onRestore(item)}
                onDelete={() => setDeleting(item)}
              />
            ))}
            {failedAt ? (
              <div
                role="row"
                data-testid="archived-pages-error"
                className="grid min-h-14 items-center border-t border-(--el-border-soft) pr-5 pl-4 first:border-t-0"
              >
                <div role="cell" className="flex items-center gap-2 py-3">
                  <AlertCircle
                    className="h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                    aria-hidden
                  />
                  <span className="text-(--el-text)">{t('list.loadFailed')}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    onClick={() => void load(failedAt.cursor)}
                  >
                    {tc('retry')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {nextCursor !== null && failedAt === null ? (
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            leftIcon={loading ? undefined : <ChevronDown className="h-4 w-4" aria-hidden />}
            onClick={() => void load(nextCursor)}
          >
            {loading ? t('list.loading') : t('list.loadMore')}
          </Button>
          <span className="text-xs text-(--el-text-secondary)">
            {t('list.shown', { count: items.length })}
          </span>
        </div>
      ) : null}
      {deleting ? (
        <DeletePageDialog
          page={{ id: deleting.id, title: titleOf(deleting) }}
          subPageCount={deleting.subPageCount}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            remove(deleting.id);
            setDeleting(null);
          }}
          onStale={() => {
            // Restored in another tab: on the list the row says so and leaves.
            staleToast(titleOf(deleting));
            remove(deleting.id);
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface ArchivedPageRowProps {
  item: PageArchivedListItemDto;
  title: string;
  showActions: boolean;
  canRestore: boolean;
  canDelete: boolean;
  restoring: boolean;
  deleting: boolean;
  onRestore: () => void;
  onDelete: () => void;
}

function ArchivedPageRow({
  item,
  title,
  showActions,
  canRestore,
  canDelete,
  restoring,
  deleting,
  onRestore,
  onDelete,
}: ArchivedPageRowProps) {
  const t = useTranslations('pages.archive');
  const ti = useTranslations('issueViews');
  const date = useArchivedAtLabel(item.archivedAt);
  const busy = restoring || deleting;

  return (
    <div
      role="row"
      data-testid={`archived-page-${item.id}`}
      aria-busy={busy || undefined}
      className={cn(
        'grid min-h-14 items-center gap-x-4 border-t border-(--el-border-soft) pr-5 pl-4 first:border-t-0 hover:bg-(--el-surface)',
        busy && 'opacity-60',
      )}
      style={{ gridTemplateColumns: archivedPagesGrid(showActions) }}
    >
      <div role="cell" className="flex min-w-0 items-start gap-2 py-2.5">
        <NotebookText className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <Link
            href={`/pages/${encodeURIComponent(item.id)}`}
            className="truncate font-medium text-(--el-text) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {title}
          </Link>
          <span className="text-[12.5px] text-(--el-text-secondary)">
            {item.subPageCount > 0
              ? t('list.subPages', { count: item.subPageCount })
              : t('list.noSubPages')}
          </span>
        </div>
      </div>

      <div role="cell" className="min-w-0 py-2.5">
        <CameFrom item={item} />
      </div>

      <div role="cell" className="min-w-0 truncate text-(--el-text-secondary)">
        {item.archivedBy?.name || ti('archivedByUnknownActor')}
      </div>

      <div role="cell" className="min-w-0 truncate text-(--el-text-secondary)">
        {date}
      </div>

      {showActions ? (
        <div role="cell" className="flex items-center justify-end gap-1">
          {canRestore ? (
            <Button
              variant="secondary"
              size="sm"
              loading={restoring}
              disabled={deleting}
              leftIcon={restoring ? undefined : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
              aria-label={restoring ? undefined : t('restoreLabel', { title })}
              onClick={onRestore}
            >
              {restoring ? t('restoring') : t('restore')}
            </Button>
          ) : null}
          {canDelete ? (
            <FolderRowMenu
              trigger="button"
              label={t('list.more', { title })}
              entries={[
                {
                  kind: 'item',
                  key: 'delete',
                  label: t('delete.menuItem'),
                  icon: Trash2,
                  tone: 'danger',
                  disabled: busy,
                  onSelect: onDelete,
                },
              ]}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Where the page was archived from: folder and page crumbs, or the project root. */
function CameFrom({ item }: { item: PageArchivedListItemDto }) {
  const t = useTranslations('pages.archive.list');
  const tp = useTranslations('pages');
  const archived = new Set(item.archivedAncestorIds);
  const crumbs = [
    ...item.cameFrom.folders.map((f) => ({ id: f.id, name: f.name, archived: false })),
    ...item.cameFrom.pages.map((p) => ({
      id: p.id,
      name: p.title || tp('untitled'),
      archived: archived.has(p.id),
    })),
  ];
  if (crumbs.length === 0) {
    return <span className="text-(--el-text-secondary)">{t('projectRoot')}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-(--el-text-secondary)">
      {crumbs.map((crumb, i) => (
        <Fragment key={crumb.id}>
          {i > 0 ? <ChevronRight className="h-3 w-3 shrink-0" aria-hidden /> : null}
          <span className="min-w-0 break-words">
            {crumb.name}
            {crumb.archived ? <i className="ml-1">{t('archivedAncestor')}</i> : null}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
