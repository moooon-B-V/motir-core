'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bookmark, ChevronLeft, ChevronRight, Lock, Search, Star, Users } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import { encodeFilterParam, FILTER_PARAM } from '@/lib/filters/ast';
import {
  listFilters,
  resolveFilter,
  rowCapabilities,
  setStar,
  type BuiltinFilterSummaryDto,
  type SavedFilterSummaryDto,
  type Viewer,
} from './savedFiltersClient';
import { FilterRowActionsMenu } from './FilterRowActionsMenu';
import { EditFilterDialog } from './EditFilterDialog';
import { ChangeOwnerDialog } from './ChangeOwnerDialog';
import { DeleteFilterDialog } from './DeleteFilterDialog';
import { SubscribeDialog } from './SubscribeDialog';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

type DialogState = {
  kind: 'edit' | 'changeOwner' | 'delete' | 'subscribe';
  filter: SavedFilterSummaryDto;
} | null;

interface PageData {
  items: SavedFilterSummaryDto[];
  builtins: BuiltinFilterSummaryDto[];
  total: number;
  nextCursor: string | null;
}

export function FiltersDirectory({ projectKey, viewer }: { projectKey: string; viewer: Viewer }) {
  const t = useTranslations('savedFilters');
  const router = useRouter();
  const { toast } = useToast();

  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  // Keyset (cursor) pagination — the 6.2.1 list is id-cursored, so we keep the
  // visited-page cursors in a stack (index 0 = first page, cursor null) and
  // walk forward/back through it; jumping to an arbitrary page isn't a keyset
  // operation, so the footer is Prev/Next + a "page N of M" indicator.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // The fetch result is TAGGED with the request key it answered, so loading /
  // error are DERIVED (`result.key !== requestKey`) rather than set
  // synchronously in the effect — no cascading-render setState (the React
  // Compiler set-state-in-effect rule).
  const requestKey = `${reloadKey} ${query} ${pageIndex}`;
  const [result, setResult] = useState<{ key: string; page: PageData | null; error: boolean }>({
    key: '',
    page: null,
    error: false,
  });

  // Debounce the search box; a new query resets to the first page.
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(rawQuery.trim());
      setCursors([null]);
      setPageIndex(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  // The bounded, server-searched page read (finding #57). Aborts in-flight
  // reads so a fast typer / pager never lands a stale page; state is set only
  // in the async resolution, tagged with the key it answered.
  useEffect(() => {
    const controller = new AbortController();
    const key = requestKey;
    listFilters(projectKey, {
      q: query || undefined,
      cursor: cursors[pageIndex] ?? undefined,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        setResult({
          key,
          page: {
            items: page.items,
            builtins: page.builtins,
            total: page.total,
            nextCursor: page.nextCursor,
          },
          error: false,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ key, page: null, error: true });
        void err;
      });
    return () => controller.abort();
  }, [projectKey, query, cursors, pageIndex, requestKey]);

  const settled = result.key === requestKey;
  const data = settled ? result.page : null;
  const loading = !settled;
  const error = settled && result.error;

  function refresh() {
    setReloadKey((k) => k + 1);
  }

  function goNext() {
    const next = data?.nextCursor;
    if (!next) return;
    setCursors((prev) => [...prev.slice(0, pageIndex + 1), next]);
    setPageIndex((i) => i + 1);
  }

  function goPrev() {
    setPageIndex((i) => Math.max(0, i - 1));
  }

  // Apply a saved (or built-in) filter on /items: resolve it to its AST and
  // navigate with the `?filter=v1:` URL the 6.1 builder reads — the saved
  // filter IS the URL once applied (reload/share keep working, no new state
  // channel). A degraded (stale/malformed) envelope can't be applied.
  async function applyFilter(filterId: string) {
    setApplyingId(filterId);
    try {
      const resolved = await resolveFilter(projectKey, filterId);
      if (!resolved.ast) {
        toast({ variant: 'error', title: t('applyError') });
        return;
      }
      const param = encodeFilterParam(resolved.ast);
      router.push(`/items?${FILTER_PARAM}=${encodeURIComponent(param)}`);
    } catch {
      toast({ variant: 'error', title: t('applyError') });
    } finally {
      setApplyingId(null);
    }
  }

  function patchRow(filterId: string, map: (f: SavedFilterSummaryDto) => SavedFilterSummaryDto) {
    setResult((prev) =>
      prev.page
        ? {
            ...prev,
            page: {
              ...prev.page,
              items: prev.page.items.map((f) => (f.id === filterId ? map(f) : f)),
            },
          }
        : prev,
    );
  }

  async function toggleStar(filter: SavedFilterSummaryDto) {
    const next = !filter.starredByMe;
    // Optimistic: flip the row's star + count immediately, reconcile on the
    // server's authoritative DTO, revert on failure.
    patchRow(filter.id, (f) => ({
      ...f,
      starredByMe: next,
      starCount: f.starCount + (next ? 1 : -1),
    }));
    try {
      const updated = await setStar(projectKey, filter.id, next);
      patchRow(filter.id, () => updated);
    } catch {
      patchRow(filter.id, () => filter);
      toast({ variant: 'error', title: t('starError') });
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const showBuiltins = pageIndex === 0 && (data?.builtins.length ?? 0) > 0;
  const hasRows = (data?.items.length ?? 0) > 0 || showBuiltins;
  // The footer count is the WHOLE directory: saved filters (`total`, the
  // paginated set) plus the built-in defaults, which are real rows in the
  // table. `builtins` is the q-filtered constant set the service returns on
  // every page (pinned to page 0 for display, never paginated), so this total
  // is stable across pages — only `totalPages` keys off the saved `total`.
  const totalFilterCount = (data?.total ?? 0) + (data?.builtins.length ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-[20rem]">
        <Input
          type="search"
          aria-label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          addonStart={<Search className="h-4 w-4" aria-hidden />}
        />
      </div>

      {error ? (
        <ErrorState title={t('error.title')} description={t('error.description')} retry={refresh} />
      ) : loading ? (
        <DirectorySkeleton />
      ) : !hasRows ? (
        query ? (
          <EmptyState
            title={t('noMatches.title', { query })}
            description={t('noMatches.description')}
          />
        ) : (
          <EmptyState
            title={t('empty.title')}
            description={t('empty.description')}
            action={
              <Button variant="secondary" onClick={() => router.push('/items')}>
                {t('empty.action')}
              </Button>
            }
          />
        )
      ) : (
        <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
          <table className="w-full border-collapse text-sm" aria-label={t('heading')}>
            <thead>
              <tr className="border-b border-(--el-border) bg-(--el-surface-soft) text-left text-xs font-semibold whitespace-nowrap text-(--el-text-secondary)">
                <th scope="col" className="w-full max-w-[0px] px-3 py-2 font-semibold">
                  {t('columns.name')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('columns.owner')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('columns.visibility')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('columns.stars')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((filter) => (
                <SavedFilterRow
                  key={filter.id}
                  filter={filter}
                  viewer={viewer}
                  applying={applyingId === filter.id}
                  onApply={() => applyFilter(filter.id)}
                  onToggleStar={() => toggleStar(filter)}
                  onSubscribe={() => setDialog({ kind: 'subscribe', filter })}
                  onEdit={() => setDialog({ kind: 'edit', filter })}
                  onChangeOwner={() => setDialog({ kind: 'changeOwner', filter })}
                  onDelete={() => setDialog({ kind: 'delete', filter })}
                />
              ))}
              {showBuiltins
                ? data?.builtins.map((builtin) => (
                    <BuiltinFilterRow
                      key={builtin.id}
                      builtin={builtin}
                      applying={applyingId === builtin.id}
                      onApply={() => applyFilter(builtin.id)}
                    />
                  ))
                : null}
            </tbody>
          </table>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border) bg-(--el-surface-soft) px-3 py-2">
            <p className="text-xs text-(--el-text-secondary)" role="status">
              {t('pager.summary', {
                count: totalFilterCount,
                page: pageIndex + 1,
                pages: totalPages,
              })}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goPrev}
                disabled={pageIndex === 0}
                aria-label={t('pager.prev')}
                className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-55"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!data?.nextCursor}
                aria-label={t('pager.next')}
                className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-55"
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === 'edit' ? (
        <EditFilterDialog
          projectKey={projectKey}
          viewer={viewer}
          filter={dialog.filter}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'changeOwner' ? (
        <ChangeOwnerDialog
          projectKey={projectKey}
          filter={dialog.filter}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'subscribe' ? (
        <SubscribeDialog
          projectKey={projectKey}
          filter={dialog.filter}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteFilterDialog
          projectKey={projectKey}
          filter={dialog.filter}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            // If the last row on a non-first page was deleted, step back so we
            // never strand the user on an empty page.
            if ((data?.items.length ?? 0) <= 1 && pageIndex > 0) {
              setCursors((prev) => prev.slice(0, pageIndex));
              setPageIndex((i) => Math.max(0, i - 1));
            } else {
              refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function VisibilityPill({ visibility }: { visibility: 'private' | 'project' }) {
  const t = useTranslations('savedFilters');
  if (visibility === 'project') {
    return (
      <Pill severity="info">
        <Users className="size-3" aria-hidden />
        {t('visibility.project')}
      </Pill>
    );
  }
  return (
    <Pill tone="neutral">
      <Lock className="size-3" aria-hidden />
      {t('visibility.private')}
    </Pill>
  );
}

function ApplyNameButton({
  name,
  description,
  visibility,
  applying,
  onApply,
}: {
  name: string;
  description?: string | null;
  visibility: 'private' | 'project' | 'builtin';
  applying: boolean;
  onApply: () => void;
}) {
  const t = useTranslations('savedFilters');
  const Glyph = visibility === 'private' ? Lock : Bookmark;
  return (
    <button
      type="button"
      onClick={onApply}
      disabled={applying}
      aria-label={t('apply', { name })}
      className="group flex w-full min-w-0 items-start gap-2 text-left disabled:opacity-60"
    >
      <Glyph className="mt-0.5 h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-(--el-text) group-hover:text-(--el-link) group-hover:underline">
          {name}
        </span>
        {description ? (
          <span className="truncate text-xs text-(--el-text-muted)">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

function SavedFilterRow({
  filter,
  viewer,
  applying,
  onApply,
  onToggleStar,
  onSubscribe,
  onEdit,
  onChangeOwner,
  onDelete,
}: {
  filter: SavedFilterSummaryDto;
  viewer: Viewer;
  applying: boolean;
  onApply: () => void;
  onToggleStar: () => void;
  onSubscribe: () => void;
  onEdit: () => void;
  onChangeOwner: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('savedFilters');
  const caps = rowCapabilities(viewer, filter);
  return (
    <tr className="border-b border-(--el-border) whitespace-nowrap last:border-b-0 hover:bg-(--el-surface-soft)">
      <td className="w-full max-w-[0px] px-3 py-2.5 align-top">
        <ApplyNameButton
          name={filter.name}
          description={filter.description}
          visibility={filter.visibility}
          applying={applying}
          onApply={onApply}
        />
      </td>
      <td className="px-3 py-2.5 align-middle text-(--el-text-secondary)">{filter.owner.name}</td>
      <td className="px-3 py-2.5 align-middle">
        <VisibilityPill visibility={filter.visibility} />
      </td>
      <td className="px-3 py-2.5 align-middle">
        <button
          type="button"
          onClick={onToggleStar}
          aria-pressed={filter.starredByMe}
          aria-label={
            filter.starredByMe
              ? t('unstar', { name: filter.name })
              : t('star', { name: filter.name })
          }
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Star
            className={
              filter.starredByMe
                ? 'h-4 w-4 fill-(--el-warning) text-(--el-warning)'
                : 'h-4 w-4 text-(--el-text-muted)'
            }
            aria-hidden
          />
          <span className="text-xs tabular-nums">{filter.starCount}</span>
        </button>
      </td>
      <td className="px-3 py-2.5 text-right align-middle">
        <FilterRowActionsMenu
          filterName={filter.name}
          canSubscribe
          canManage={caps.canManage}
          canChangeOwner={caps.canChangeOwner}
          onSubscribe={onSubscribe}
          onEdit={onEdit}
          onChangeOwner={onChangeOwner}
          onDelete={onDelete}
        />
      </td>
    </tr>
  );
}

function BuiltinFilterRow({
  builtin,
  applying,
  onApply,
}: {
  builtin: BuiltinFilterSummaryDto;
  applying: boolean;
  onApply: () => void;
}) {
  const t = useTranslations('savedFilters');
  return (
    <tr className="border-b border-(--el-border) whitespace-nowrap last:border-b-0 hover:bg-(--el-surface-soft)">
      <td className="w-full max-w-[0px] px-3 py-2.5 align-top">
        <ApplyNameButton
          name={t(`builtinNames.${builtin.slug}`)}
          visibility="builtin"
          applying={applying}
          onApply={onApply}
        />
      </td>
      <td className="px-3 py-2.5 align-middle text-(--el-text-muted)">{t('builtinOwner')}</td>
      <td className="px-3 py-2.5 align-middle">
        <Pill tone="neutral">{t('visibility.builtin')}</Pill>
      </td>
      <td className="px-3 py-2.5 align-middle text-(--el-text-muted)">{t('ownerNone')}</td>
      <td className="px-3 py-2.5" />
    </tr>
  );
}

function DirectorySkeleton() {
  return (
    <div
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
      aria-hidden
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-(--el-border) px-3 py-3 last:border-b-0"
        >
          <div className="h-4 flex-1 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-4 w-24 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-5 w-16 animate-pulse rounded-(--radius-badge) bg-(--el-muted)" />
          <div className="h-4 w-8 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </div>
      ))}
    </div>
  );
}
