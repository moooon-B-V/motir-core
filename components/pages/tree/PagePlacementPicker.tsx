'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  Loader2,
  NotebookText,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { PageParentDto, PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ROOT_LEVEL, parentKey, rowKey, type LevelKey } from './pageTreeRow';

// THE MOVE TO… PICKER for a page (Story MOTIR-5753 · MOTIR-7374) —
// `design/pages/pages--tree.mock.html` panels 9–10, `design-notes.md` § The page
// tree, "Move to…". Composed from the shipped `FolderPickerPanel`'s parts — the
// title, the refusal slot at the top, a `listbox` of options tracked with
// `aria-activedescendant`, picking commits, picking the current location writes
// nothing — with the design's two differences, both because pages are many:
//
//   · the options are a LAZILY EXPANDED TREE — each option's chevron reads that
//     level through `GET /api/pages/tree` (MOTIR-7372), 100 at a time with a
//     Load more, exactly as the tree itself does;
//   · there is NO SEARCH FIELD (this story has no page search), so the listbox
//     itself takes focus and the arrow keys: ↑/↓ move, → expands, ← collapses,
//     Enter picks, Esc dismisses.
//
// **Project root** is the first option. **The moving page is disabled** with
// its reason and has NO chevron, so its sub-pages are never offered — the cycle
// is refused before anything is sent. A refusal the picker could not have known
// (depth, another project, gone) arrives from the write as `refusal` and renders
// at the top; the tree is untouched.
//
// It is presentational about the WRITE — the tree owns it (`usePageMove`) — and
// owns only its own reads. Every read is stamped per level, so a re-expand or a
// Load more can never be overwritten by an older answer.

/** Per-level indent of an option, matching the tree's own 22px. */
const INDENT_PX = 22;
/** Rows per picker read: the route's maximum — a picker shows names, not a page of work. */
const PICKER_LEVEL_SIZE = 100;

interface PickerLevel {
  rows: PageTreeRowDto[];
  nextCursor: string | null;
  loading: boolean;
  failed: boolean;
}

type PickerLine =
  | {
      type: 'option';
      key: string;
      parent: PageParentDto;
      name: string;
      untitled: boolean;
      icon: 'root' | 'folder' | 'page';
      depth: number;
      expandable: boolean;
      expanded: boolean;
      disabledReason: string | null;
      current: boolean;
    }
  | { type: 'loading'; key: string; depth: number }
  | { type: 'failed'; key: string; depth: number; level: LevelKey }
  | { type: 'more'; key: string; depth: number; level: LevelKey };

export interface PagePlacementPickerProps {
  /** The page being moved. */
  pageId: string;
  /** Its title as the tree shows it (Untitled already resolved) — the picker's title. */
  title: string;
  /** Where the page sits now. */
  currentParent: PageParentDto;
  /** The project's key for the level reads; the active project when omitted. */
  projectKey?: string;
  /** A refusal from the last write, shown at the top. */
  refusal: string | null;
  pending?: boolean;
  /** Pick a destination; `name` is how the picker shows it (named in a refusal). */
  onPick: (parent: PageParentDto, name: string) => void;
  onDismiss: () => void;
}

export function PagePlacementPicker({
  pageId,
  title,
  currentParent,
  projectKey,
  refusal,
  pending = false,
  onPick,
  onDismiss,
}: PagePlacementPickerProps) {
  const t = useTranslations('pages');
  const tf = useTranslations('folders');
  const tc = useTranslations('common');
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [levels, setLevels] = useState<Record<LevelKey, PickerLevel>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<LevelKey>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const levelSeq = useRef<Record<LevelKey, number>>({});

  const read = useCallback(
    async (level: LevelKey, cursor: string | null) => {
      const seq = (levelSeq.current[level] ?? 0) + 1;
      levelSeq.current[level] = seq;
      setLevels((prev) => ({
        ...prev,
        [level]: {
          ...(prev[level] ?? { rows: [], nextCursor: null }),
          loading: true,
          failed: false,
        },
      }));
      const query = new URLSearchParams({ parent: level, limit: String(PICKER_LEVEL_SIZE) });
      if (projectKey) query.set('projectKey', projectKey);
      if (cursor) query.set('cursor', cursor);
      let answer: PageTreeLevelDto | null = null;
      try {
        const res = await fetch(`/api/pages/tree?${query.toString()}`);
        if (res.ok) answer = (await res.json()) as PageTreeLevelDto;
      } catch {
        answer = null;
      }
      if (levelSeq.current[level] !== seq) return;
      setLevels((prev) => {
        const current = prev[level] ?? {
          rows: [],
          nextCursor: null,
          loading: false,
          failed: false,
        };
        if (!answer) return { ...prev, [level]: { ...current, loading: false, failed: true } };
        return {
          ...prev,
          [level]: {
            rows: cursor ? [...current.rows, ...answer.rows] : answer.rows,
            nextCursor: answer.nextCursor,
            loading: false,
            failed: false,
          },
        };
      });
    },
    [projectKey],
  );

  // The root is read when the picker opens (the tree re-keys it after a `gone`
  // refusal, so the list it then shows is the tree as it now is).
  const readRootOnMount = useRef(true);
  useEffect(() => {
    if (!readRootOnMount.current) return;
    readRootOnMount.current = false;
    void read(ROOT_LEVEL, null);
  }, [read]);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const toggle = useCallback(
    (level: LevelKey) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(level)) next.delete(level);
        else next.add(level);
        return next;
      });
      const state = levels[level];
      if (!expanded.has(level) && (!state || state.failed)) void read(level, null);
    },
    [expanded, levels, read],
  );

  const currentKey = parentKey(currentParent);

  const lines = useMemo(() => {
    const out: PickerLine[] = [
      {
        type: 'option',
        key: ROOT_LEVEL,
        parent: { kind: 'root' },
        name: tf('projectRoot'),
        untitled: false,
        icon: 'root',
        depth: 0,
        expandable: false,
        expanded: false,
        disabledReason: null,
        current: currentKey === ROOT_LEVEL,
      },
    ];
    const walk = (level: LevelKey, depth: number) => {
      const state = levels[level];
      if (!state || (state.loading && state.rows.length === 0)) {
        out.push({ type: 'loading', key: `loading:${level}`, depth });
        return;
      }
      if (state.failed && state.rows.length === 0) {
        out.push({ type: 'failed', key: `failed:${level}`, depth, level });
        return;
      }
      for (const row of state.rows) {
        const key = rowKey(row);
        const self = row.kind === 'page' && row.id === pageId;
        const expandable = !self && (row.kind === 'folder' || row.hasChildren);
        const open = expandable && expanded.has(key);
        out.push({
          type: 'option',
          key,
          parent:
            row.kind === 'folder' ? { kind: 'folder', id: row.id } : { kind: 'page', id: row.id },
          name: row.kind === 'folder' ? row.name : row.title || t('untitled'),
          untitled: row.kind === 'page' && !row.title,
          icon: row.kind,
          depth,
          expandable,
          expanded: open,
          disabledReason: self ? t('tree.picker.isThisPage') : null,
          current: key === currentKey,
        });
        if (open) walk(key, depth + 1);
      }
      if (state.loading) out.push({ type: 'loading', key: `loading-more:${level}`, depth });
      else if (state.failed)
        out.push({ type: 'failed', key: `failed-more:${level}`, depth, level });
      else if (state.nextCursor) out.push({ type: 'more', key: `more:${level}`, depth, level });
    };
    if (levels[ROOT_LEVEL]) walk(ROOT_LEVEL, 0);
    return out;
  }, [levels, expanded, pageId, currentKey, t, tf]);

  const options = lines.filter(
    (line): line is Extract<PickerLine, { type: 'option' }> => line.type === 'option',
  );
  const enabled = options.filter((o) => o.disabledReason === null);
  const active = enabled.find((o) => o.key === activeKey) ?? enabled[0] ?? null;
  const optionId = (key: string) => `${listId}-${key.replace(':', '-')}`;
  const root = levels[ROOT_LEVEL];
  const rootLoading = !root || (root.loading && root.rows.length === 0);

  const choose = (option: Extract<PickerLine, { type: 'option' }>) => {
    if (option.disabledReason !== null || pending) return;
    if (option.current) onDismiss();
    else onPick(option.parent, option.name);
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The panel sits inside the tree's React tree; its row keys must not see these.
    e.stopPropagation();
    const at = active ? enabled.indexOf(active) : -1;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (enabled.length === 0) return;
        const next =
          e.key === 'ArrowDown'
            ? (at + 1) % enabled.length
            : (at - 1 + enabled.length) % enabled.length;
        setActiveKey(enabled[next]!.key);
        break;
      }
      case 'ArrowRight':
        e.preventDefault();
        if (active?.expandable && !active.expanded) toggle(active.key);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (active?.expanded) toggle(active.key);
        break;
      case 'Enter':
        e.preventDefault();
        if (active) choose(active);
        break;
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
      default:
        break;
    }
  };

  const pad = (depth: number) => ({
    paddingLeft: `calc(var(--spacing-control-x) + ${depth * INDENT_PX}px)`,
  });
  const quiet =
    'flex items-center gap-2 py-(--spacing-control-y) text-[13px] text-(--el-text-secondary)';

  return (
    <div className="flex flex-col" data-testid="page-placement-picker">
      <div className="px-2.5 pt-2 pb-1.5 text-xs font-semibold text-(--el-text-secondary)">
        {tf('pickerTitle', { name: title })}
      </div>
      {refusal ? (
        <div
          role="alert"
          className="mx-1 mt-0.5 mb-1.5 flex items-start gap-1.5 rounded-(--radius-control) border border-(--el-danger) bg-(--el-tint-rose) px-2.5 py-2 text-xs text-(--el-text-strong)"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
          <span>{refusal}</span>
        </div>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={0}
        aria-label={t('tree.picker.listLabel')}
        aria-busy={rootLoading || undefined}
        aria-activedescendant={active ? optionId(active.key) : undefined}
        onKeyDown={onListKeyDown}
        className="max-h-72 overflow-y-auto rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {lines.map((line) => {
          if (line.type === 'loading') {
            return (
              <div key={line.key} role="none" className={quiet} style={pad(line.depth)}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {t('tree.picker.loading')}
              </div>
            );
          }
          if (line.type === 'failed') {
            return (
              <div key={line.key} role="none" className={quiet} style={pad(line.depth)}>
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
                <span className="text-(--el-text)">{t('tree.levelFailed')}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void read(line.level, levels[line.level]?.nextCursor ?? null);
                  }}
                  className="text-(--el-link) underline underline-offset-2"
                >
                  {tc('retry')}
                </button>
              </div>
            );
          }
          if (line.type === 'more') {
            return (
              <div key={line.key} role="none" className={quiet} style={pad(line.depth)}>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void read(line.level, levels[line.level]?.nextCursor ?? null);
                  }}
                  className="inline-flex items-center gap-1.5 text-(--el-link) underline underline-offset-2"
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  {t('tree.loadMore')}
                </button>
              </div>
            );
          }
          const disabled = line.disabledReason !== null;
          const Glyph =
            line.icon === 'root' ? FolderInput : line.icon === 'folder' ? Folder : NotebookText;
          return (
            <div
              key={line.key}
              id={optionId(line.key)}
              role="option"
              aria-selected={line.current}
              aria-disabled={disabled || undefined}
              data-testid="page-placement-option"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                if (!disabled) setActiveKey(line.key);
              }}
              onClick={(e) => {
                e.stopPropagation();
                choose(line);
              }}
              style={pad(line.depth)}
              className={cn(
                'flex w-full items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13px]',
                disabled
                  ? 'cursor-default text-(--el-text-faint)'
                  : 'cursor-pointer text-(--el-text)',
                active?.key === line.key && 'bg-(--el-surface)',
              )}
            >
              {line.expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={
                    line.expanded
                      ? t('tree.collapseAria', { title: line.name })
                      : t('tree.expandAria', { title: line.name })
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(line.key);
                  }}
                  className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:text-(--el-text)"
                >
                  <ChevronRight
                    className={cn('h-3 w-3 transition-transform', line.expanded && 'rotate-90')}
                    aria-hidden
                  />
                </button>
              ) : (
                <span className="h-4 w-4 shrink-0" aria-hidden />
              )}
              <Glyph
                className={cn(
                  'mt-px h-4 w-4 shrink-0',
                  line.icon === 'page' ? 'text-(--el-icon-muted)' : 'text-(--el-text-secondary)',
                )}
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className={cn('truncate', line.untitled && !disabled && 'italic')}>
                  {line.name}
                </span>
                {line.disabledReason ? (
                  <span className="text-[11.5px] text-(--el-text-secondary)">
                    {line.disabledReason}
                  </span>
                ) : null}
              </span>
              {line.current ? (
                <span className="ml-auto shrink-0 text-[11.5px] text-(--el-text-secondary)">
                  {tf('currentLocation')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
