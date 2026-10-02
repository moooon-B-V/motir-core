'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronDown, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { FolderMenuEntry } from '@/app/(authed)/items/_components/FolderRowMenu';
import type { PageParentDto, PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { PageTreeFolderRow } from './PageTreeFolderRow';
import { PageTreePageRow } from './PageTreePageRow';
import { useCreatePage } from './useCreatePage';
import {
  DENSITY,
  ROOT_LEVEL,
  parentKey,
  parentOf,
  rowKey,
  type LevelKey,
  type PageTreeDensity,
  type PageTreeFolderRowDto,
  type PageTreePageRowDto,
  type TreeItemProps,
} from './pageTreeRow';

// THE PAGE TREE (Story MOTIR-5753 · MOTIR-7373) — `design/pages/pages--tree.mock.html`
// panels 1–8 and `design-notes.md` § The page tree. A project's folders and
// pages as ONE lazily-read tree: each level is folders first, then pages, read
// 50 at a time through `GET /api/pages/tree` (MOTIR-7372) under one keyset
// cursor, so a level ends in **Load more** (with how many are SHOWN — a keyset
// cursor knows no total) rather than a page count.
//
// ── STATE ──────────────────────────────────────────────────────────────────
// Every level lives in `levels`, keyed by the row that owns it (`root`,
// `folder:<id>`, `page:<id>` — also the `parent` the route takes). A level is
// read only when its row is first expanded; a FAILED level is re-read on the
// next expand, or by its row's Try again. Each read is stamped per level, and a
// read applies only while it is still that level's newest — so an overlapping
// Load more, retry or re-expand can never be clobbered by an older answer.
//
// ── THIS IS A CLIENT ISLAND (CLAUDE.md § Page state after a mutation) ───────
// `initialRoot` seeds `useState` ONCE; `router.refresh()` does not reach it.
// The only mutation this card makes from inside the tree is a create, which
// navigates away; a later card that changes the tree in place (MOTIR-7374's
// moves, MOTIR-7376's drag) updates `levels` through `reload` / the same
// per-level stamps, never through a refresh.
//
// ── ACCESSIBILITY ──────────────────────────────────────────────────────────
// `role="tree"` with flat `treeitem`s carrying `aria-level` / `aria-expanded` /
// `aria-busy`, and ONE row in the tab order (roving tabindex): ↑/↓ move, →
// expands or steps into the first child, ← collapses or steps to the parent,
// Home / End jump, Enter opens a page or toggles a folder. The synthetic rows
// (loading, failed, empty, Load more, Creating page…) are `role="none"` — their
// controls are ordinary buttons in the tab order, as the design draws them.
//
// ── WINDOWING ──────────────────────────────────────────────────────────────
// A long level is windowed by `useRowWindow` (the generalised form of
// `TreeTable`'s windowing): only the rows near the viewport mount, the
// container keeps the full height, and it degrades to rendering every row where
// no viewport is measurable.
//
// ── SEAMS FOR THE NEXT CARDS ───────────────────────────────────────────────
// `pageMenuEntries` / `folderMenuEntries` append to a row's menu after this
// card's New entry (MOTIR-7374: Move to…, Move up / down, the folder commands).
// `density="compact"` is the page route's sidebar (MOTIR-7375); `initialRoot`
// may be omitted there, and the root is then read on mount.

const PAGE_LEVEL_SIZE = 50;

/** One lazily-read level. */
interface LevelState {
  rows: PageTreeRowDto[];
  nextCursor: string | null;
  /** A read in flight: the level's first (`initial`) or a Load more (`more`). */
  loading: 'initial' | 'more' | null;
  /** The last read failed: the first one, or a Load more. */
  failed: 'initial' | 'more' | null;
}

const FRESH: LevelState = { rows: [], nextCursor: null, loading: null, failed: null };

/** One line of the flattened, visible tree. */
type Item =
  | {
      type: 'row';
      key: string;
      row: PageTreeRowDto;
      depth: number;
      /** The row key of the row this one sits under; null at the root. */
      parent: string | null;
      expandable: boolean;
      expanded: boolean;
      busy: boolean;
    }
  | { type: 'loading'; key: string; depth: number }
  | { type: 'failed'; key: string; depth: number; level: LevelKey; more: boolean }
  | { type: 'empty'; key: string; depth: number; level: LevelKey }
  | { type: 'more'; key: string; depth: number; level: LevelKey; shown: number }
  | { type: 'creating'; key: string; depth: number };

export interface PageTreeProps {
  /**
   * The root level as the server read it. `null` means that read FAILED (the
   * first-level error state, with Try again); omitted, the root is read on mount.
   */
  initialRoot?: PageTreeLevelDto | null;
  /** The project's key, passed to the level read; the active project when omitted. */
  projectKey?: string;
  /** Whether the reader holds `page:edit` — New entries and row menus. */
  canEdit: boolean;
  /** What an empty project shows in place of the tree (the shipped `EmptyState`). */
  emptyState?: ReactNode;
  /** Row metrics: `/pages`' 40px rows, or the sidebar's compact ones. */
  density?: PageTreeDensity;
  /** Entries appended to a page row's menu, after New sub-page. */
  pageMenuEntries?: (row: PageTreePageRowDto) => FolderMenuEntry[];
  /** Entries appended to a folder row's menu, after New page here. */
  folderMenuEntries?: (row: PageTreeFolderRowDto) => FolderMenuEntry[];
}

/** Walk up from `el` to the nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function PageTree({
  initialRoot,
  projectKey,
  canEdit,
  emptyState,
  density = 'default',
  pageMenuEntries,
  folderMenuEntries,
}: PageTreeProps) {
  const t = useTranslations('pages.tree');
  const tc = useTranslations('common');
  const ti = useTranslations('pages.index');
  const { pending, create } = useCreatePage();
  const metrics = DENSITY[density];

  const [levels, setLevels] = useState<Record<LevelKey, LevelState>>(() => ({
    [ROOT_LEVEL]:
      initialRoot === undefined
        ? { ...FRESH, loading: 'initial' }
        : initialRoot === null
          ? { ...FRESH, failed: 'initial' }
          : { ...FRESH, rows: initialRoot.rows, nextCursor: initialRoot.nextCursor },
  }));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const levelSeq = useRef<Record<LevelKey, number>>({});

  // ⚠️ THE ONE PLACE A LEVEL IS READ. `more` appends after the level's cursor;
  // otherwise the level is read from its start and replaces what was there.
  const read = useCallback(
    async (level: LevelKey, more: boolean, cursor: string | null) => {
      const seq = (levelSeq.current[level] ?? 0) + 1;
      levelSeq.current[level] = seq;
      setLevels((prev) => ({
        ...prev,
        [level]: { ...(prev[level] ?? FRESH), loading: more ? 'more' : 'initial', failed: null },
      }));
      const query = new URLSearchParams({ parent: level, limit: String(PAGE_LEVEL_SIZE) });
      if (projectKey) query.set('projectKey', projectKey);
      if (more && cursor) query.set('cursor', cursor);
      let answer: PageTreeLevelDto | null = null;
      try {
        const res = await fetch(`/api/pages/tree?${query.toString()}`);
        if (res.ok) answer = (await res.json()) as PageTreeLevelDto;
      } catch {
        answer = null;
      }
      if (levelSeq.current[level] !== seq) return; // a newer read of this level won
      setLevels((prev) => {
        const current = prev[level] ?? FRESH;
        if (!answer) {
          return {
            ...prev,
            [level]: { ...current, loading: null, failed: more ? 'more' : 'initial' },
          };
        }
        return {
          ...prev,
          [level]: {
            rows: more ? [...current.rows, ...answer.rows] : answer.rows,
            nextCursor: answer.nextCursor,
            loading: null,
            failed: null,
          },
        };
      });
    },
    [projectKey],
  );

  // The root, when the server did not read it (the sidebar's case).
  const readRootOnMount = useRef(initialRoot === undefined);
  useEffect(() => {
    if (!readRootOnMount.current) return;
    readRootOnMount.current = false;
    void read(ROOT_LEVEL, false, null);
  }, [read]);

  const toggle = useCallback(
    (key: string) => {
      if (expanded.has(key)) {
        const next = new Set(expanded);
        next.delete(key);
        setExpanded(next);
        return;
      }
      const next = new Set(expanded);
      next.add(key);
      setExpanded(next);
      const level = levels[key];
      // Read a level on its first expand, and again after a failed read.
      if (!level || level.failed) void read(key, false, null);
    },
    [expanded, levels, read],
  );

  const retry = useCallback(
    (level: LevelKey, more: boolean) => {
      void read(level, more, more ? (levels[level]?.nextCursor ?? null) : null);
    },
    [levels, read],
  );

  const pendingLevel = pending ? parentKey(pending) : null;

  // ── Flatten the visible tree ──────────────────────────────────────────────
  const items = useMemo(() => {
    const out: Item[] = [];
    const creating = (level: LevelKey, depth: number) => {
      if (pendingLevel === level) out.push({ type: 'creating', key: `creating:${level}`, depth });
    };
    const walk = (level: LevelKey, depth: number, parent: string | null) => {
      const state = levels[level];
      if (!state || state.loading === 'initial') {
        creating(level, depth);
        out.push({ type: 'loading', key: `loading:${level}`, depth });
        return;
      }
      if (state.failed === 'initial') {
        creating(level, depth);
        out.push({ type: 'failed', key: `failed:${level}`, depth, level, more: false });
        return;
      }
      let pagesStarted = false;
      for (const row of state.rows) {
        // The pending row sits FIRST among the level's pages — after its folders.
        if (row.kind === 'page' && !pagesStarted) {
          pagesStarted = true;
          creating(level, depth);
        }
        const key = rowKey(row);
        const expandable = row.kind === 'folder' || row.hasChildren;
        const open = expandable && expanded.has(key);
        out.push({
          type: 'row',
          key,
          row,
          depth,
          parent,
          expandable,
          expanded: open,
          busy: open && levels[key]?.loading === 'initial',
        });
        if (open) walk(key, depth + 1, key);
        else creating(key, depth + 1);
      }
      if (!pagesStarted) creating(level, depth);
      if (state.rows.length === 0 && level !== ROOT_LEVEL && pendingLevel !== level) {
        out.push({ type: 'empty', key: `empty:${level}`, depth, level });
      }
      if (state.loading === 'more') {
        out.push({ type: 'loading', key: `loading-more:${level}`, depth });
      } else if (state.failed === 'more') {
        out.push({ type: 'failed', key: `failed-more:${level}`, depth, level, more: true });
      } else if (state.nextCursor) {
        out.push({ type: 'more', key: `more:${level}`, depth, level, shown: state.rows.length });
      }
    };
    walk(ROOT_LEVEL, 1, null);
    return out;
  }, [levels, expanded, pendingLevel]);

  // ── Focus: one row in the tab order ───────────────────────────────────────
  const rowItems = useMemo(
    () => items.flatMap((item, index) => (item.type === 'row' ? [{ item, index }] : [])),
    [items],
  );
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const activeKey = useMemo(() => {
    if (focusedKey && rowItems.some(({ item }) => item.key === focusedKey)) return focusedKey;
    return rowItems[0]?.item.key ?? null;
  }, [focusedKey, rowItems]);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const pendingFocus = useRef<string | null>(null);

  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: items.length,
    estimateRowHeight: metrics.rowPx,
  });

  const focusRow = useCallback(
    (key: string) => {
      setFocusedKey(key);
      const el = rowRefs.current.get(key);
      if (el) {
        el.focus();
        return;
      }
      // Off the window: scroll it in, and focus it once it mounts.
      pendingFocus.current = key;
      const index = items.findIndex((item) => item.key === key);
      const scroller = scrollParent(containerRef.current);
      if (scroller && index >= 0) {
        const top =
          (containerRef.current?.getBoundingClientRect().top ?? 0) -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop +
          getOffset(index);
        scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
      }
    },
    [items, containerRef, getOffset],
  );

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const el = rowRefs.current.get(key);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  }, [range, items]);

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, item: Extract<Item, { type: 'row' }>) => {
      if (e.target !== e.currentTarget) return; // a control inside the row owns its keys
      const at = rowItems.findIndex(({ item: r }) => r.key === item.key);
      const go = (index: number) => {
        const target = rowItems[Math.max(0, Math.min(index, rowItems.length - 1))];
        if (target) focusRow(target.item.key);
      };
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          go(at + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          go(at - 1);
          break;
        case 'Home':
          e.preventDefault();
          go(0);
          break;
        case 'End':
          e.preventDefault();
          go(rowItems.length - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (item.expandable && !item.expanded) toggle(item.key);
          else if (item.expanded) {
            const next = rowItems[at + 1]?.item;
            if (next && next.parent === item.key) focusRow(next.key);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (item.expanded) toggle(item.key);
          else if (item.parent) focusRow(item.parent);
          break;
        case 'Enter':
          e.preventDefault();
          if (item.row.kind === 'folder') toggle(item.key);
          else linkRefs.current.get(item.key)?.click();
          break;
        default:
          break;
      }
    },
    [rowItems, focusRow, toggle],
  );

  // ── The row menus — this card's New entry, then whatever a later card adds ──
  const pageMenu = (row: PageTreePageRowDto): FolderMenuEntry[] | null =>
    canEdit
      ? [
          {
            kind: 'item',
            key: 'new-sub-page',
            label: t('newSubPage'),
            icon: Plus,
            onSelect: () => void create({ kind: 'page', id: row.id }),
          },
          ...(pageMenuEntries?.(row) ?? []),
        ]
      : null;
  const folderMenu = (row: PageTreeFolderRowDto): FolderMenuEntry[] | null =>
    canEdit
      ? [
          {
            kind: 'item',
            key: 'new-page-here',
            label: t('newPageHere'),
            icon: Plus,
            onSelect: () => void create({ kind: 'folder', id: row.id }),
          },
          ...(folderMenuEntries?.(row) ?? []),
        ]
      : null;

  // ── The whole-tree states ─────────────────────────────────────────────────
  const root = levels[ROOT_LEVEL]!;
  const frame =
    'overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)';

  if (root.failed === 'initial') {
    return (
      <div className={frame} data-surface="card" data-testid="page-tree-failed">
        <div
          role="alert"
          className="flex items-center gap-2.5 px-(--spacing-card-padding) py-4 text-sm text-(--el-text)"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
          <span className="flex-1">{t('rootFailed')}</span>
          <Button variant="secondary" size="sm" onClick={() => retry(ROOT_LEVEL, false)}>
            {tc('retry')}
          </Button>
        </div>
      </div>
    );
  }

  const rootEmpty =
    root.loading === null && root.rows.length === 0 && root.nextCursor === null && !pending;
  if (rootEmpty && emptyState !== undefined) return <>{emptyState}</>;

  const padFor = (depth: number) => metrics.gutterPx + depth * metrics.indentPx;

  const renderItem = (item: Item, index: number) => {
    const style = {
      height: metrics.rowPx,
      paddingLeft: padFor(item.depth),
      ...(windowing
        ? { position: 'absolute' as const, top: getOffset(index), left: 0, right: 0 }
        : null),
    };
    const measure = measureElement(index);

    if (item.type === 'row') {
      const itemRef = (el: HTMLDivElement | null) => {
        measure(el);
        if (el) rowRefs.current.set(item.key, el);
        else rowRefs.current.delete(item.key);
      };
      const treeItem: TreeItemProps = {
        depth: item.depth,
        tabIndex: item.key === activeKey ? 0 : -1,
        onKeyDown: (e) => onRowKeyDown(e, item),
        onFocus: (e) => {
          if (e.target === e.currentTarget) setFocusedKey(item.key);
        },
        style,
      };
      return item.row.kind === 'folder' ? (
        <PageTreeFolderRow
          key={item.key}
          row={item.row}
          item={treeItem}
          itemRef={itemRef}
          expanded={item.expanded}
          busy={item.busy}
          onToggle={() => toggle(item.key)}
          menu={folderMenu(item.row)}
        />
      ) : (
        <PageTreePageRow
          key={item.key}
          row={item.row}
          item={treeItem}
          itemRef={itemRef}
          expanded={item.expanded}
          busy={item.busy}
          onToggle={() => toggle(item.key)}
          linkRef={(el: HTMLAnchorElement | null) => {
            if (el) linkRefs.current.set(item.key, el);
            else linkRefs.current.delete(item.key);
          }}
          menu={pageMenu(item.row)}
        />
      );
    }

    const synthetic = 'flex items-center gap-2 pr-2 text-[13px] text-(--el-text-secondary)';
    const slot = <span className="h-4 w-4 shrink-0" aria-hidden />;
    let body: ReactNode;
    switch (item.type) {
      case 'loading':
        body = (
          <span role="status" className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('loadingLevel')}
          </span>
        );
        break;
      case 'creating':
        body = (
          <span role="status" className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            <span className="text-(--el-text)">{ti('creating')}</span>
          </span>
        );
        break;
      case 'failed':
        body = (
          <>
            <span role="alert" className="inline-flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
              <span className="text-(--el-text)">{t('levelFailed')}</span>
            </span>
            <button
              type="button"
              onClick={() => retry(item.level, item.more)}
              className="text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {tc('retry')}
            </button>
          </>
        );
        break;
      case 'empty': {
        const parent: PageParentDto = parentOf(item.level);
        body = (
          <>
            <span>{t('noPagesHere')}</span>
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => void create(parent)}
              >
                {parent.kind === 'page' ? t('newSubPage') : t('newPageHere')}
              </Button>
            ) : null}
          </>
        );
        break;
      }
      case 'more':
        body = (
          <>
            <button
              type="button"
              onClick={() => retry(item.level, true)}
              className="inline-flex items-center gap-1.5 text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              {t('loadMore')}
            </button>
            <span className="text-[12.5px]">{t('shown', { count: item.shown })}</span>
          </>
        );
        break;
    }
    return (
      <div
        key={item.key}
        ref={measure}
        role="none"
        data-testid={`page-tree-${item.type}`}
        className={synthetic}
        style={style}
      >
        {slot}
        {body}
      </div>
    );
  };

  return (
    <div className={frame} data-surface="card">
      <div
        ref={containerRef}
        role="tree"
        aria-label={t('label')}
        className="divide-y divide-(--el-border-soft)"
        style={windowing ? { position: 'relative', height: totalSize } : undefined}
      >
        {items.slice(range.start, range.end).map((item, i) => renderItem(item, range.start + i))}
      </div>
    </div>
  );
}
