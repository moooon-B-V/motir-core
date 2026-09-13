'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronUp,
  Folder as FolderIcon,
  FolderPlus,
  Loader2,
  Pencil,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import { useToast } from '@/components/ui/Toast';
import { serverActionRejectionKey } from '@/lib/utils/serverActionRejection';
import type { FolderDto } from '@/lib/dto/folders';
import type { Locale } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils/cn';
import {
  buildIssueListHref,
  nextSort,
  serializeSort,
  ISSUE_TITLE_MIN_TRACK,
  type IssueSort,
  type IssueSortColumn,
} from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FolderTreeRowDto, ProjectTreeRowDto, TreeLevelDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { buildIssueColumns } from './issueColumns';
import { IssueInlineEditProvider } from './IssueInlineEdit';
import { usePeekRowClick } from './IssueQuickView';
import { makeRowShaper, type IssueRowData } from './issueRows';
import {
  createFolderAction,
  listChildIssuesAction,
  listFolderLevelAction,
  listRootIssuesAction,
  renameFolderAction,
  type FolderWriteResult,
} from '../actions';
import { useFolderCommands } from './FolderCommands';
import { FolderNameField } from './FolderNameField';
import { FolderRowMenu, type FolderMenuEntry } from './FolderRowMenu';
import { useCreateIssue } from '../../_components/CreateIssueProvider';

// The /items TREE table (Subtask 2.5.3, made LAZY + SORTABLE in 2.5.14 for
// finding #57). The Server Component (IssueTreeSection) loads the FIRST page of
// ROOTS via the 2.5.13 read; this client wrapper fetches each node's children
// ON EXPAND (one level at a time) + "Load more children" past the per-node page,
// and the column headers SORT (re-reading via the sorted reads). It composes the
// generic TreeTable primitive (2.5.2) with the shared issue cells (issueColumns)
// — column-identical to the List. Sort lives in the URL (?sort=, like the List);
// a sort change REMOUNTS this component (keyed by sort in the parent), so the
// tree re-seeds from freshly-sorted roots. VIRTUALIZATION is its own 2.5.15.

/** Sentinel level key for the project roots (never a real work-item id). */
const ROOTS = '__roots__';

/**
 * A FOLDER's row id and level key (Story MOTIR-5308 · MOTIR-5315). Folders and
 * work items live in different tables, so their ids never collide in practice —
 * the prefix makes that a property of the key rather than of the id generator,
 * and lets `fetchLevel` tell a folder's level from a work item's children.
 */
const FOLDER_PREFIX = 'folder:';
const folderKey = (folderId: string) => `${FOLDER_PREFIX}${folderId}`;

/** A node the TreeTable renders: a real issue, a folder, or a synthetic status
 *  row — the lazy "loading…" placeholder, the "Load more children" affordance,
 *  or an expanded folder's "nothing filed here" row. */
type TreeNode =
  | { kind: 'issue'; row: IssueRowData }
  | { kind: 'folder'; folder: FolderTreeRowDto; expanded: boolean; renaming: boolean }
  | { kind: 'folderDraft' }
  | { kind: 'loading' }
  | { kind: 'emptyFolder' }
  | { kind: 'loadmore'; parentKey: string; loaded: number; total: number };

/**
 * The inline folder NAME ROW that is open, if any (MOTIR-5344): a new folder
 * being named in one level, or an existing folder being renamed. One at a time.
 */
type FolderDraft =
  | { mode: 'create'; levelKey: string; parentFolderId: string | null }
  | { mode: 'rename'; folderId: string };

/** One lazily-loaded level: the accumulated rows + the level's full total. */
interface LevelState {
  rows: ProjectTreeRowDto[];
  total: number;
  hasMore: boolean;
  loading: boolean;
}

export interface IssueTreeTableProps {
  /** The first page of project roots (from listRootIssues). */
  initialLevel: TreeLevelDto;
  sort: IssueSort;
  /** Preserved across a header-sort navigation (the filter applies to the Tree too). */
  filter: IssueFilter;
  /** Carried to the client so lazily-fetched levels shape identically to the roots. */
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  /**
   * Whether the viewer holds `work_item:edit` on the project. Nothing on the
   * folder ROWS needs it — a read-only member sees and expands folders exactly
   * like an editor — but every folder ACTION (create, rename, move, delete) is
   * gated on it, and those read it from here.
   */
  canEdit?: boolean;
  /**
   * What an EMPTY project renders (the section's drawn empty state). The tree
   * stays mounted for an empty project so the toolbar's "New folder" has a level
   * to put the new folder in; this is shown whenever there is nothing to draw.
   */
  emptyState?: ReactNode;
}

export function IssueTreeTable({
  initialLevel,
  sort,
  filter,
  workflow,
  members,
  canEdit = false,
  emptyState,
}: IssueTreeTableProps) {
  const t = useTranslations();
  const tv = useTranslations('issueViews');
  const { toast } = useToast();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  // A plain click on an issue row opens the quick-view peek (the per-row eye was
  // removed in MOTIR-1306); ⌘/ctrl/middle-click still opens the detail page via
  // the row link's real href. Synthetic rows (loading / load-more) carry no href.
  const onPeekClick = usePeekRowClick();
  const sortParam = serializeSort(sort);
  const shape = useMemo(
    () => makeRowShaper(workflow, members, locale),
    [workflow, members, locale],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [levels, setLevels] = useState<Record<string, LevelState>>(() => ({
    [ROOTS]: {
      rows: initialLevel.rows,
      total: initialLevel.total,
      hasMore: initialLevel.hasMore,
      loading: false,
    },
  }));

  // The open folder name row (MOTIR-5344), its refusal, and whether its write is
  // in flight. `draftSeq` retires a write whose row was closed or replaced while
  // it was pending, so a late answer never reopens or refuses a newer row.
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const draftSeq = useRef(0);

  // ⚠️ THE ONE PLACE LEVEL STATE CHANGES. Every level — the roots, a work item's
  // children, a folder's contents — lives in `levels`, keyed by its container,
  // and each level carries a sequence number: a fetch applies its result only if
  // no later fetch (or in-place update) for the SAME level started after it, so
  // an overlapping load-more, refetch or folder action can never be clobbered by
  // an older response (CLAUDE.md § Page state after a mutation, case 3). The
  // folder action cards update a level through this state and bump the same
  // sequence; they add no second copy of it.
  const levelSeq = useRef<Record<string, number>>({});

  // Fetch one level (a parent's children, a folder's contents, or more roots)
  // and store / append it.
  const fetchLevel = useCallback(
    (parentId: string, offset: number, append: boolean) => {
      const seq = (levelSeq.current[parentId] ?? 0) + 1;
      levelSeq.current[parentId] = seq;
      setLevels((prev) => ({
        ...prev,
        [parentId]: {
          rows: prev[parentId]?.rows ?? [],
          total: prev[parentId]?.total ?? 0,
          hasMore: prev[parentId]?.hasMore ?? false,
          loading: true,
        },
      }));
      startTransition(async () => {
        const result =
          parentId === ROOTS
            ? await listRootIssuesAction({ sortParam, offset })
            : parentId.startsWith(FOLDER_PREFIX)
              ? await listFolderLevelAction({
                  folderId: parentId.slice(FOLDER_PREFIX.length),
                  sortParam,
                  offset,
                })
              : await listChildIssuesAction({ parentId, sortParam, offset });
        if (levelSeq.current[parentId] !== seq) return; // a newer read of this level won
        setLevels((prev) => {
          const existing = prev[parentId];
          if (!result.ok) {
            return existing ? { ...prev, [parentId]: { ...existing, loading: false } } : prev;
          }
          const rows =
            append && existing ? [...existing.rows, ...result.level.rows] : result.level.rows;
          return {
            ...prev,
            [parentId]: {
              rows,
              total: result.level.total,
              hasMore: result.level.hasMore,
              loading: false,
            },
          };
        });
      });
    },
    [sortParam],
  );

  // A create elsewhere in the shell — the /items "+ New work item" toolbar
  // trigger, the global "C" shortcut, the ⌘K command — commits through the
  // shell's CreateIssueProvider, which calls router.refresh() AND bumps
  // `issuesChangedAt`. router.refresh() re-runs the Server Component (which hands
  // us a fresh `initialLevel`), but our ROOTS level is seeded into client state
  // ONCE on mount (the lazy-tree model — `useState` initializer), so a refresh
  // can't reach it and the new row stayed invisible until a full reload
  // (bug-issue-list-not-refreshed-after-create). Mirror BoardContainer: watch the
  // tick and refetch the first page of roots, preserving the user's expanded
  // subtrees. Skip the initial render (no create has happened yet); a sort change
  // remounts this component (keyed by sort in the parent), so the ref resets too.
  const { issuesChangedAt } = useCreateIssue();
  const sawFirstTick = useRef(false);
  useEffect(() => {
    if (!sawFirstTick.current) {
      sawFirstTick.current = true;
      return;
    }
    fetchLevel(ROOTS, 0, false);
  }, [issuesChangedAt, fetchLevel]);

  // Expanding a not-yet-loaded parent kicks its first children fetch.
  const onExpandedChange = useCallback(
    (next: Set<string>) => {
      for (const id of next) {
        if (!expanded.has(id) && !levels[id]) fetchLevel(id, 0, false);
      }
      setExpanded(next);
    },
    [expanded, levels, fetchLevel],
  );

  // ── Folder create + rename (MOTIR-5344) ─────────────────────────────────────
  const openDraft = useCallback((next: FolderDraft) => {
    draftSeq.current += 1;
    setDraftPending(false);
    setDraftError(null);
    setDraft(next);
  }, []);
  const cancelDraft = useCallback(() => {
    draftSeq.current += 1;
    setDraftPending(false);
    setDraftError(null);
    setDraft(null);
  }, []);
  const clearDraftError = useCallback(() => setDraftError(null), []);

  const startRootCreate = useCallback(
    () => openDraft({ mode: 'create', levelKey: ROOTS, parentFolderId: null }),
    [openDraft],
  );
  // "New folder inside" expands the parent first, so the name row opens in view.
  const startCreateInside = useCallback(
    (folder: FolderTreeRowDto) => {
      const key = folderKey(folder.id);
      if (!expanded.has(key)) onExpandedChange(new Set(expanded).add(key));
      openDraft({ mode: 'create', levelKey: key, parentFolderId: folder.id });
    },
    [expanded, onExpandedChange, openDraft],
  );
  const startRename = useCallback(
    (folder: FolderTreeRowDto) => openDraft({ mode: 'rename', folderId: folder.id }),
    [openDraft],
  );

  // The toolbar's "New folder" reaches this island through the command channel.
  const folderCommands = useFolderCommands();
  useEffect(() => {
    if (!folderCommands || !canEdit) return;
    folderCommands.registerNewRootFolder(startRootCreate);
    return () => folderCommands.registerNewRootFolder(null);
  }, [folderCommands, canEdit, startRootCreate]);

  // A created folder joins its level IN PLACE, after the level's last folder and
  // before its work items — where the service appended it — and its parent folder
  // now has children. Bumping the level's sequence retires any read of that level
  // still in flight, which was taken before the folder existed.
  const insertFolder = useCallback((levelKey: string, folder: FolderDto) => {
    levelSeq.current[levelKey] = (levelSeq.current[levelKey] ?? 0) + 1;
    setLevels((prev) => {
      const level = prev[levelKey];
      if (!level) return prev;
      const row: FolderTreeRowDto = {
        kind: 'folder',
        id: folder.id,
        parentId: null,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
        position: folder.position,
        hasChildren: false,
      };
      let lastFolder = -1;
      level.rows.forEach((r, i) => {
        if (r.kind === 'folder') lastFolder = i;
      });
      const next: Record<string, LevelState> = {
        ...prev,
        [levelKey]: {
          ...level,
          rows: [...level.rows.slice(0, lastFolder + 1), row, ...level.rows.slice(lastFolder + 1)],
          total: level.total + 1,
          loading: false,
        },
      };
      if (folder.parentFolderId !== null) {
        const parentId = folder.parentFolderId;
        for (const [key, lvl] of Object.entries(next)) {
          if (lvl.rows.some((r) => r.kind === 'folder' && r.id === parentId)) {
            next[key] = {
              ...lvl,
              rows: lvl.rows.map((r) =>
                r.kind === 'folder' && r.id === parentId ? { ...r, hasChildren: true } : r,
              ),
            };
          }
        }
      }
      return next;
    });
  }, []);

  // A rename replaces the name wherever the folder is loaded, in place.
  const renameInLevels = useCallback((folder: FolderDto) => {
    setLevels((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [key, lvl] of Object.entries(prev)) {
        if (lvl.rows.some((r) => r.kind === 'folder' && r.id === folder.id)) {
          changed = true;
          next[key] = {
            ...lvl,
            rows: lvl.rows.map((r) =>
              r.kind === 'folder' && r.id === folder.id ? { ...r, name: folder.name } : r,
            ),
          };
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const submitDraft = useCallback(
    (raw: string) => {
      if (!draft) return;
      const name = raw.trim();
      if (name.length === 0) {
        setDraftError(t('folders.nameRequired'));
        return;
      }
      const current = draft;
      const seq = ++draftSeq.current;
      setDraftPending(true);
      startTransition(async () => {
        let res: FolderWriteResult;
        try {
          res =
            current.mode === 'create'
              ? await createFolderAction({ parentFolderId: current.parentFolderId, name })
              : await renameFolderAction({ folderId: current.folderId, name });
        } catch (err) {
          if (draftSeq.current !== seq) return;
          setDraftPending(false);
          toast({ variant: 'error', title: tv(serverActionRejectionKey(err)) });
          return;
        }
        if (draftSeq.current !== seq) return; // the row was closed or replaced meanwhile
        setDraftPending(false);
        if (!res.ok) {
          if (res.code === 'FOLDER_NAME_TAKEN') setDraftError(t('folders.nameTaken', { name }));
          else if (res.code === 'INVALID_FOLDER_NAME') setDraftError(t('folders.nameRequired'));
          else toast({ variant: 'error', title: res.error });
          return;
        }
        setDraft(null);
        setDraftError(null);
        if (current.mode === 'create') insertFolder(current.levelKey, res.folder);
        else renameInLevels(res.folder);
      });
    },
    [draft, t, tv, toast, insertFolder, renameInLevels],
  );

  const folderMenuEntries = useCallback(
    (folder: FolderTreeRowDto): FolderMenuEntry[] => [
      {
        kind: 'item',
        key: 'new-folder-inside',
        label: t('folders.newFolderInside'),
        icon: FolderPlus,
        onSelect: () => startCreateInside(folder),
      },
      {
        kind: 'item',
        key: 'rename',
        label: t('folders.rename'),
        icon: Pencil,
        onSelect: () => startRename(folder),
      },
    ],
    [t, startCreateInside, startRename],
  );

  // A folder row's whole-row target (and Enter on the row) toggles it — a folder
  // has no quick view, so expanding is the only thing its row does.
  const toggleFolder = useCallback(
    (key: string) => {
      const next = new Set(expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onExpandedChange(next);
    },
    [expanded, onExpandedChange],
  );

  // "Load more children" (or more roots) — append the next page. A folder row
  // (activated by Enter; a click lands on its own target) toggles.
  const onRowActivate = useCallback(
    (id: string, data: TreeNode) => {
      if (data.kind === 'loadmore') fetchLevel(data.parentKey, data.loaded, true);
      else if (data.kind === 'folder' && !data.renaming) toggleFolder(id);
    },
    [fetchLevel, toggleFolder],
  );

  const onSort = useCallback(
    (column: IssueSortColumn) => {
      router.push(
        buildIssueListHref(pathname, { view: 'tree', sort: nextSort(sort, column), filter }),
      );
    },
    [router, pathname, sort, filter],
  );

  // Build the nested TreeTable model from the loaded levels + the expanded set.
  const rows = useMemo<TreeTableRow<TreeNode>[]>(() => {
    // An expanded container's children: a loading row until its first page
    // lands, then its rows (+ "Load more children" past the page). An expanded
    // FOLDER with nothing in it gets one quiet row instead of none, so an empty
    // folder reads as empty rather than broken (the design's panel 7).
    const expandInto = (node: TreeTableRow<TreeNode>, key: string, isFolder: boolean) => {
      const lvl = levels[key];
      if (!lvl || (lvl.loading && lvl.rows.length === 0)) {
        node.busy = true;
        node.children = [{ id: `${key}::loading`, data: { kind: 'loading' } }];
        return;
      }
      node.busy = lvl.loading;
      const namingHere = draft?.mode === 'create' && draft.levelKey === key;
      if (isFolder && lvl.rows.length === 0 && !lvl.hasMore && !namingHere) {
        node.children = [{ id: `${key}::empty`, data: { kind: 'emptyFolder' } }];
        return;
      }
      const childRows = buildLevel(lvl.rows, lvl.total, key);
      node.children = lvl.hasMore
        ? [
            ...childRows,
            {
              id: `${key}::loadmore`,
              data: { kind: 'loadmore', parentKey: key, loaded: lvl.rows.length, total: lvl.total },
            },
          ]
        : childRows;
    };

    // A level is its FOLDERS, then its work items (MOTIR-5314's read order). An
    // open NEW-folder name row sits between the two, where the folder will land.
    const buildLevel = (
      level: ProjectTreeRowDto[],
      total: number,
      levelKey: string,
    ): TreeTableRow<TreeNode>[] => {
      const nodes = level.map((dto, i): TreeTableRow<TreeNode> => {
        if (dto.kind === 'folder') {
          const key = folderKey(dto.id);
          const isExpanded = expanded.has(key);
          const node: TreeTableRow<TreeNode> = {
            id: key,
            data: {
              kind: 'folder',
              folder: dto,
              expanded: isExpanded,
              renaming: draft?.mode === 'rename' && draft.folderId === dto.id,
            },
            // Always expandable: an empty folder opens onto its empty row.
            hasChildren: true,
            posinset: i + 1,
            setsize: total,
          };
          if (isExpanded) expandInto(node, key, true);
          return node;
        }
        const node: TreeTableRow<TreeNode> = {
          id: dto.id,
          data: { kind: 'issue', row: shape(dto) },
          hasChildren: dto.hasChildren,
          posinset: i + 1,
          setsize: total,
        };
        if (dto.hasChildren && expanded.has(dto.id)) expandInto(node, dto.id, false);
        return node;
      });
      if (draft?.mode === 'create' && draft.levelKey === levelKey) {
        let lastFolder = -1;
        level.forEach((r, i) => {
          if (r.kind === 'folder') lastFolder = i;
        });
        nodes.splice(lastFolder + 1, 0, {
          id: `${levelKey}::new-folder`,
          data: { kind: 'folderDraft' },
        });
      }
      return nodes;
    };

    const root = levels[ROOTS] ?? { rows: [], total: 0, hasMore: false, loading: false };
    const rootRows = buildLevel(root.rows, root.total, ROOTS);
    return root.hasMore
      ? [
          ...rootRows,
          {
            id: `${ROOTS}::loadmore`,
            data: {
              kind: 'loadmore',
              parentKey: ROOTS,
              loaded: root.rows.length,
              total: root.total,
            },
          },
        ]
      : rootRows;
  }, [levels, expanded, shape, draft]);

  // Columns: the shared issue cells, wrapped to (a) render synthetic status rows
  // in the tree column only, (b) make every header a sort button with aria-sort.
  const columns = useMemo<TreeTableColumn<TreeNode>[]>(
    () =>
      buildIssueColumns(t).map((col, idx, all) => {
        const isTree = idx === 0;
        const isLast = idx === all.length - 1;
        // A column with no sortColumn gets a plain screen-reader-only header
        // (no sort button, no aria-sort). None declares that today — MOTIR-4258
        // removed the trailing actions column, which was the only one.
        const sortCol = col.sortColumn;
        const active = sortCol ? sort.column === sortCol : false;
        const ariaSort: 'ascending' | 'descending' | 'none' | undefined = sortCol
          ? active
            ? sort.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
          : undefined;
        return {
          key: col.key,
          // Forward the fixed column width: without it TreeTable falls back to
          // `max-content`, sizing each independently-gridded row to its OWN
          // content so the header row and data rows land on DIFFERENT column
          // grids (bug-tree-header-misalignment). The List + static Tree keep
          // the width; the sortable Tree must too.
          width: col.width,
          align: col.align,
          ariaSort,
          headerLabel: col.header,
          header: sortCol ? (
            <SortHeader
              label={col.header}
              active={active}
              sort={sort}
              onSort={() => onSort(sortCol)}
              alignEnd={col.align === 'end'}
            />
          ) : (
            <span className="sr-only">{col.header}</span>
          ),
          cell: (node: TreeNode) => {
            if (node.kind === 'issue') return col.cell(node.row);
            // Folder and synthetic rows render only in the tree column — a folder
            // has no status, type or assignee, so its other cells stay EMPTY. The
            // one exception is a folder's actions button, trailing the row, for an
            // editor (MOTIR-5344).
            if (!isTree) {
              if (isLast && node.kind === 'folder' && canEdit && !node.renaming) {
                return (
                  <FolderRowMenu
                    label={t('folders.actionsAria', { name: node.folder.name })}
                    entries={folderMenuEntries(node.folder)}
                  />
                );
              }
              return null;
            }
            if (node.kind === 'folderDraft' || (node.kind === 'folder' && node.renaming)) {
              return (
                <>
                  <FolderIcon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                  <div className="ml-2 flex min-w-0 flex-1">
                    <FolderNameField
                      initialName={node.kind === 'folder' ? node.folder.name : ''}
                      error={draftError}
                      pending={draftPending}
                      onSubmit={submitDraft}
                      onCancel={cancelDraft}
                      onEdit={clearDraftError}
                    />
                  </div>
                </>
              );
            }
            if (node.kind === 'folder') {
              const { name } = node.folder;
              return (
                <>
                  {/* The whole-row target. A folder row's click expands and
                      collapses; it never opens anything. The chevron raises
                      itself above it, as it does above a work item's link. */}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={
                      node.expanded
                        ? t('folders.collapseAria', { name })
                        : t('folders.expandAria', { name })
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFolder(folderKey(node.folder.id));
                    }}
                    className="absolute inset-0 z-0 cursor-pointer focus:outline-none"
                  />
                  <FolderIcon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                  <span className="ml-2 min-w-0 truncate font-semibold text-(--el-text)">
                    {name}
                  </span>
                </>
              );
            }
            if (node.kind === 'emptyFolder') {
              return (
                <span className="text-[13px] text-(--el-text-secondary)">
                  {t('folders.emptyFolder')}
                </span>
              );
            }
            if (node.kind === 'loading') {
              return (
                <span className="flex items-center gap-2 text-(--el-text-secondary)">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Loading children…
                </span>
              );
            }
            return (
              <span className="relative z-10 flex items-center gap-1.5 text-(--el-link)">
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                Load more children
                <span className="text-(--el-text-secondary)">
                  Showing {node.loaded} of {node.total}
                </span>
              </span>
            );
          },
        };
      }),
    [
      sort,
      onSort,
      t,
      toggleFolder,
      canEdit,
      folderMenuEntries,
      draftError,
      draftPending,
      submitDraft,
      cancelDraft,
      clearDraftError,
    ],
  );

  // An empty project draws the section's empty state — unless a new root folder
  // is being named, which is a row to draw.
  if (emptyState && rows.length === 0) return <>{emptyState}</>;

  return (
    <IssueInlineEditProvider workflow={workflow} members={members}>
      <TreeTable
        label={t('issues.list.tableLabel')}
        columns={columns}
        flexMin={ISSUE_TITLE_MIN_TRACK}
        rows={rows}
        expandedIds={expanded}
        onExpandedChange={onExpandedChange}
        onRowActivate={onRowActivate}
        getRowHref={(node) => (node.kind === 'issue' ? `/items/${node.row.identifier}` : undefined)}
        getRowLabel={(node) =>
          node.kind === 'issue' ? `${node.row.identifier} ${node.row.title}` : ''
        }
        onRowLinkClick={(e, node) => {
          if (node.kind === 'issue') onPeekClick(e, node.row.identifier);
        }}
        getRowTestId={(node) =>
          node.kind === 'issue'
            ? `issue-row-${node.row.identifier}`
            : node.kind === 'folder'
              ? `folder-row-${node.folder.id}`
              : node.kind === 'folderDraft'
                ? 'folder-draft-row'
                : undefined
        }
      />
    </IssueInlineEditProvider>
  );
}

/** A column-header sort button — the same affordance the List ships (caret
 *  hidden by default, faint on hover, solid on the active column). */
function SortHeader({
  label,
  active,
  sort,
  onSort,
  alignEnd,
}: {
  label: ReactNode;
  active: boolean;
  sort: IssueSort;
  onSort: () => void;
  alignEnd?: boolean;
}) {
  const Caret = active && sort.direction === 'desc' ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      onClick={onSort}
      className={cn(
        'group/sort relative z-10 -ml-1 flex min-w-0 items-center gap-1 rounded-(--radius-control) px-1 py-0.5 text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase hover:text-(--el-text)',
        'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
        alignEnd && '-mr-1 ml-auto flex-row-reverse',
      )}
    >
      <span className="truncate">{label}</span>
      <Caret
        className={cn(
          'h-3 w-3 shrink-0 transition-opacity',
          active
            ? 'text-(--el-text-secondary) opacity-100'
            : 'text-(--el-text-faint) opacity-0 group-hover/sort:opacity-100',
        )}
        aria-hidden
      />
    </button>
  );
}
