'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Bookmark, Check, ChevronDown, Lock, Search, Star, Users } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import { clearFacets, setAdvancedParam } from '@/lib/issues/issueListAdvancedFilter';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import { appliedFromResolved } from '@/lib/issues/savedFilterApplied';
import { cn } from '@/lib/utils/cn';
import {
  listFilters,
  resolveFilter,
  setStar,
  type BuiltinFilterSummaryDto,
  type SavedFilterSummaryDto,
  type Viewer,
} from '@/app/(authed)/filters/_components/savedFiltersClient';
import { useToast } from '@/components/ui/Toast';
import { useSavedFilterSession } from './SavedFilterContext';

// The [Saved] filter dropdown (Story 6.2 · Subtask 6.2.3), per
// design/work-items/saved-filters.mock.html panel 2: a ToolbarButton (bookmark +
// caret, right of [Advanced]) opening a 320px listbox — a server-backed,
// debounced search over the FIXED group order Starred → My filters → Project
// filters → Defaults, a per-row star toggle (a sibling focusable button, never
// nested in the option), and a "View all filters" footer to the /filters
// directory. The trigger goes active (accent ring + lavender fill) while a saved
// filter is applied; the applied entry carries the check (aria-selected).
//
// Applying an entry resolves the stored envelope (the 6.2.1 read) into the
// builder AST and writes `?filter=v1:` — the URL stays the single state channel
// (reload/share keep working; no new surface) — and records WHICH filter is
// applied in the session (the name chip's source). The reads are bounded
// (finding #57): one server page (50) + the built-in defaults, q-searched.

const SEARCH_DEBOUNCE_MS = 250;

interface PageData {
  items: SavedFilterSummaryDto[];
  builtins: BuiltinFilterSummaryDto[];
}

export interface SavedFilterDropdownProps {
  projectKey: string;
  viewer: Viewer;
  view: IssueListView;
  sort: IssueSort;
  filter: IssueFilter;
  /** The decoded active AST — only used so the apply path can compose URLs
   * (the dropdown itself reads the applied filter from the session). */
  ast: FilterAst | null;
}

export function SavedFilterDropdown({
  projectKey,
  viewer,
  view,
  sort,
  filter,
}: SavedFilterDropdownProps) {
  const t = useTranslations('savedFilters');
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const session = useSavedFilterSession();

  // Open state is lifted to the session (the name chip opens this dropdown from
  // the summary row); a local fallback keeps the component usable standalone.
  const [localOpen, setLocalOpen] = useState(false);
  const open = session?.dropdownOpen ?? localOpen;
  const setOpen = session?.setDropdownOpen ?? setLocalOpen;
  const applied = session?.applied ?? null;

  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const requestKey = `${query} ${open ? '1' : '0'}`;
  const [result, setResult] = useState<{ key: string; page: PageData | null; error: boolean }>({
    key: '',
    page: null,
    error: false,
  });

  // Debounce the search box.
  useEffect(() => {
    const id = setTimeout(() => setQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  // The bounded, server-searched read — only while the menu is open. Aborts
  // in-flight reads; state is set only on resolution, tagged with its key.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const key = requestKey;
    listFilters(projectKey, { q: query || undefined, limit: 50, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setResult({ key, page: { items: page.items, builtins: page.builtins }, error: false });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ key, page: null, error: true });
        void err;
      });
    return () => controller.abort();
  }, [projectKey, query, open, requestKey]);

  const settled = result.key === requestKey;
  const data = open && settled ? result.page : null;
  const loading = open && !settled;
  const error = open && settled && result.error;

  const groups = useMemo(() => {
    const items = data?.items ?? [];
    const starred = items.filter((f) => f.starredByMe);
    const mine = items.filter((f) => !f.starredByMe && f.owner.id === viewer.userId);
    const project = items.filter((f) => !f.starredByMe && f.owner.id !== viewer.userId);
    return { starred, mine, project, builtins: data?.builtins ?? [] };
  }, [data, viewer.userId]);

  function patchRow(id: string, map: (f: SavedFilterSummaryDto) => SavedFilterSummaryDto) {
    setResult((prev) =>
      prev.page
        ? {
            ...prev,
            page: { ...prev.page, items: prev.page.items.map((f) => (f.id === id ? map(f) : f)) },
          }
        : prev,
    );
  }

  async function toggleStar(f: SavedFilterSummaryDto) {
    const next = !f.starredByMe;
    patchRow(f.id, (r) => ({ ...r, starredByMe: next, starCount: r.starCount + (next ? 1 : -1) }));
    try {
      const updated = await setStar(projectKey, f.id, next);
      patchRow(f.id, () => updated);
    } catch {
      patchRow(f.id, () => f);
      toast({ variant: 'error', title: t('starError') });
    }
  }

  async function apply(filterId: string) {
    setApplyingId(filterId);
    try {
      const resolved = await resolveFilter(projectKey, filterId);
      const next = appliedFromResolved(resolved);
      if (!next || resolved.ast === null) {
        toast({ variant: 'error', title: t('applyError') });
        return;
      }
      session?.setApplied(next);
      setOpen(false);
      router.push(
        buildIssueListHref(pathname, {
          view,
          sort,
          filter: setAdvancedParam(clearFacets(filter), resolved.ast),
        }),
      );
    } catch {
      toast({ variant: 'error', title: t('applyError') });
    } finally {
      setApplyingId(null);
    }
  }

  const triggerActive = applied !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-label={t('dropdown.trigger')}
          className={cn(
            'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            triggerActive ? 'border-(--el-accent) bg-(--el-tint-lavender)' : 'border-(--el-border)',
          )}
        >
          <Bookmark
            className={cn(
              'h-4 w-4',
              triggerActive ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-muted)',
            )}
            aria-hidden
          />
          {t('dropdown.label')}
          <ChevronDown className="h-3.5 w-3.5 text-(--el-text-muted)" aria-hidden />
        </button>
      </Popover.Trigger>

      <Popover.Content aria-label={t('dropdown.label')} align="start" width={320} className="p-0">
        {/* Search */}
        <div className="border-b border-(--el-border) p-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-[15px] w-[15px] -translate-y-1/2 text-(--el-text-muted)"
              aria-hidden
            />
            <input
              type="text"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder={t('dropdown.searchPlaceholder')}
              aria-label={t('dropdown.searchLabel')}
              className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) pr-2.5 pl-8 font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            />
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-1.5">
          {error ? (
            <p className="px-(--spacing-control-x) py-3 text-sm text-(--el-text-muted)">
              {t('dropdown.error')}
            </p>
          ) : loading ? (
            <p className="px-(--spacing-control-x) py-3 text-sm text-(--el-text-muted)">
              {t('loading')}
            </p>
          ) : (
            <>
              <Group
                label={t('dropdown.starred')}
                empty={t('dropdown.emptyStarred')}
                count={groups.starred.length}
              >
                {groups.starred.map((f) => (
                  <FilterOption
                    key={f.id}
                    filter={f}
                    selected={applied?.id === f.id}
                    applying={applyingId === f.id}
                    onApply={() => apply(f.id)}
                    onToggleStar={() => toggleStar(f)}
                  />
                ))}
              </Group>
              <Group
                label={t('dropdown.mine')}
                empty={t('dropdown.emptyMine')}
                count={groups.mine.length}
              >
                {groups.mine.map((f) => (
                  <FilterOption
                    key={f.id}
                    filter={f}
                    selected={applied?.id === f.id}
                    applying={applyingId === f.id}
                    onApply={() => apply(f.id)}
                    onToggleStar={() => toggleStar(f)}
                  />
                ))}
              </Group>
              <Group
                label={t('dropdown.project')}
                empty={t('dropdown.emptyProject')}
                count={groups.project.length}
              >
                {groups.project.map((f) => (
                  <FilterOption
                    key={f.id}
                    filter={f}
                    selected={applied?.id === f.id}
                    applying={applyingId === f.id}
                    onApply={() => apply(f.id)}
                    onToggleStar={() => toggleStar(f)}
                  />
                ))}
              </Group>
              <Group label={t('dropdown.defaults')} count={groups.builtins.length}>
                {groups.builtins.map((b) => (
                  <BuiltinOption
                    key={b.id}
                    builtin={b}
                    selected={applied?.id === b.id}
                    applying={applyingId === b.id}
                    onApply={() => apply(b.id)}
                  />
                ))}
              </Group>
            </>
          )}
        </div>

        {/* Footer — View all filters → /filters */}
        <div className="border-t border-(--el-border) p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/filters');
            }}
            className="inline-flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-link) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <Bookmark className="h-4 w-4" aria-hidden />
            {t('dropdown.viewAll')}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}

/** A labelled group; renders its empty line (when provided) when it has no
 * rows, and renders nothing at all when empty with no `empty` line (Defaults
 * always has built-ins, so it has none). */
function Group({
  label,
  empty,
  count,
  children,
}: {
  label: string;
  empty?: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0 && !empty) return null;
  return (
    <div role="group" aria-label={label} className="py-0.5">
      <div
        aria-hidden
        className="px-2 py-1 font-mono text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase"
      >
        {label}
      </div>
      {count === 0 && empty ? (
        <p className="px-2 py-1 text-[13px] text-(--el-text-muted)">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

function OptionShell({
  selected,
  applying,
  onApply,
  star,
  label,
  secondary,
}: {
  selected: boolean;
  applying: boolean;
  onApply: () => void;
  star?: React.ReactNode;
  label: string;
  secondary: React.ReactNode;
}) {
  // Each row is two SIBLING buttons — the apply button + the star toggle — not
  // a `role="option"`. An ARIA listbox may contain only options (no interactive
  // children), so a list of filters with a per-row star can't be a listbox
  // without tripping `aria-required-children` + `nested-interactive`. A grouped
  // set of buttons is the honest, a11y-clean shape (the applied row carries
  // `aria-current`, never colour-only).
  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 rounded-(--radius-control) text-sm text-(--el-text)',
        applying && 'opacity-60',
      )}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">{star}</span>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        disabled={applying}
        onClick={onApply}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--radius-control) py-(--spacing-control-y) pr-(--spacing-control-x) text-left hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
          selected && 'bg-(--el-surface)',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex max-w-[130px] shrink-0 items-center gap-1 truncate text-xs text-(--el-text-secondary)">
          {secondary}
        </span>
        <Check
          aria-hidden
          className={cn(
            'h-4 w-4 shrink-0 text-(--el-accent-on-surface)',
            selected ? 'opacity-100' : 'opacity-0',
          )}
        />
      </button>
    </div>
  );
}

function FilterOption({
  filter,
  selected,
  applying,
  onApply,
  onToggleStar,
}: {
  filter: SavedFilterSummaryDto;
  selected: boolean;
  applying: boolean;
  onApply: () => void;
  onToggleStar: () => void;
}) {
  const t = useTranslations('savedFilters');
  const shared = filter.visibility === 'project';
  return (
    <OptionShell
      selected={selected}
      applying={applying}
      onApply={onApply}
      star={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          aria-pressed={filter.starredByMe}
          aria-label={
            filter.starredByMe
              ? t('unstar', { name: filter.name })
              : t('star', { name: filter.name })
          }
          className="inline-flex h-5 w-5 items-center justify-center rounded-(--radius-control) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Star
            className={
              filter.starredByMe
                ? 'h-4 w-4 fill-(--el-warning) text-(--el-warning)'
                : 'h-4 w-4 text-(--el-text-muted)'
            }
            aria-hidden
          />
        </button>
      }
      label={filter.name}
      secondary={
        shared ? (
          <>
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{filter.owner.name}</span>
          </>
        ) : (
          <>
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('visibility.private')}</span>
          </>
        )
      }
    />
  );
}

function BuiltinOption({
  builtin,
  selected,
  applying,
  onApply,
}: {
  builtin: BuiltinFilterSummaryDto;
  selected: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  const t = useTranslations('savedFilters');
  return (
    <OptionShell
      selected={selected}
      applying={applying}
      onApply={onApply}
      label={t(`builtinNames.${builtin.slug}`)}
      secondary={<span className="truncate">{t('visibility.builtin')}</span>}
    />
  );
}
