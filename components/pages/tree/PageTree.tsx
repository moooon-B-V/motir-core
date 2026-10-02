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
import { AlertCircle, ChevronDown, Folder, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { useFolderCommands } from '@/components/folders/FolderCommands';
import { FolderDeleteDialog } from '@/components/folders/FolderDeleteDialog';
import { FolderNameField } from '@/components/folders/FolderNameField';
import { FolderPickerPanel } from '@/components/folders/FolderPicker';
import type { FolderMenuEntry } from '@/components/folders/FolderRowMenu';
import type { FolderCommandActions } from '@/components/folders/folderActions';
import type { FolderDeletionPreviewDto, FolderPickerNodeDto } from '@/lib/dto/folders';
import type { PageParentDto, PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { serverActionRejectionKey } from '@/lib/utils/serverActionRejection';
import { PagePlacementPicker } from './PagePlacementPicker';
import { PageRowMenu } from './PageRowMenu';
import { PageTreeFolderMenu } from './PageTreeFolderMenu';
import { PageTreeFolderRow } from './PageTreeFolderRow';
import { PageTreePageRow } from './PageTreePageRow';
import { useCreatePage } from './useCreatePage';
import { reorderNeighbours, usePageMove } from './usePageMove';
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
// A create navigates away. Every change made IN the tree (MOTIR-7374) updates
// `levels` itself: a page move or a folder move / reorder / delete RE-READS the
// affected loaded levels through `refreshLevels` — the same `read`, under the
// same per-level stamps — and a folder create / rename is applied in place. A
// write is never applied before the server answers, so a refusal leaves the tree
// exactly as it was; and each write is stamped per subject, so an older answer
// never lands after a newer one.
//
// ── MOVING (MOTIR-7374) ────────────────────────────────────────────────────
// A page row's menu (`PageRowMenu`): New sub-page · Move to… | Move up · Move
// down — Move to… opens `PagePlacementPicker` anchored to the menu, and every
// placement goes through `usePageMove`. A folder row's menu is the shared
// `FolderRowMenu` with the shipped folder commands after New page here, through
// the folder actions the page HANDS in (`folderActions` — `components/` may not
// import the `/items` server actions) and only for a reader who may also write
// folders (`canEditFolders`, `work_item:edit`). The header's New folder reaches
// this island through the shared `FolderCommands` channel, as on `/items`.
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
// `pageMenuEntries` / `folderMenuEntries` still append to a row's menu, after
// everything above. Drag (MOTIR-7376) moves through the same `usePageMove`,
// whose `refresh` is this tree's `refreshLevels`.
//
// ── A PATH OPEN ON ARRIVAL (MOTIR-7375) ────────────────────────────────────
// `expandedPath` names the rows open on first paint, root-first (the page
// route's trail, or `/pages?folder=<id>`'s chain), and `initialLevels` carries
// the levels the server already read for them — so the path paints open, and a
// level the server could not read is read here on mount. `selectedPageId` is the
// page being read (`aria-selected`, the active-row treatment); `revealKey` (the
// selected page's row by default) is the row scrolled into view and made the
// tab stop, and `focusRevealed` also moves focus to it. `density="compact"` is
// the page route's sidebar: no card frame, no rules, the rail's row grammar.

const PAGE_LEVEL_SIZE = 50;
/** The route's ceiling for one read — a re-read keeps up to this many loaded rows. */
const PAGE_LEVEL_SIZE_MAX = 100;

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
  | { type: 'creating'; key: string; depth: number }
  | { type: 'draft'; key: string; depth: number };

/** The inline folder name row that is open: a new folder in one level, or a rename. */
type FolderDraft =
  | { mode: 'create'; levelKey: LevelKey; parentFolderId: string | null }
  | { mode: 'rename'; folderId: string };

/** The open Move to… picker: a page's (`PagePlacementPicker`) or a folder's (`FolderPickerPanel`). */
type PickerState =
  | {
      kind: 'page';
      pageId: string;
      title: string;
      levelKey: LevelKey;
      refusal: string | null;
      pending: boolean;
      /** Bumped to re-open the list fresh after a `gone` refusal. */
      epoch: number;
    }
  | {
      kind: 'folder';
      folderId: string;
      name: string;
      levelKey: LevelKey;
      parentFolderId: string | null;
      folders: FolderPickerNodeDto[] | null;
      truncated: boolean;
      refusal: string | null;
      pending: boolean;
    };

/** The open folder delete confirmation. */
interface DeleteState {
  folderId: string;
  name: string;
  levelKey: LevelKey;
  preview: FolderDeletionPreviewDto | null;
  refusal: string | null;
  pending: boolean;
}

type FolderActionResult = Awaited<ReturnType<FolderCommandActions['moveFolder']>>;

/** The folder a folder row's level sits in — a folder level's id, or `null` at the root. */
function folderParentOf(levelKey: LevelKey): string | null {
  const parent = parentOf(levelKey);
  return parent.kind === 'folder' ? parent.id : null;
}

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
  /** Entries appended to a folder row's menu, after the folder commands. */
  folderMenuEntries?: (row: PageTreeFolderRowDto) => FolderMenuEntry[];
  /**
   * The folder commands' transport — the `/items` server actions, handed in by
   * the page (`components/` cannot import them). Without it a folder row's menu
   * holds New page here alone.
   */
  folderActions?: FolderCommandActions;
  /** Whether the reader may also write FOLDERS (`work_item:edit`, the key every folder write asserts). */
  canEditFolders?: boolean;
  /** The page being read — its row is selected (the page route's sidebar). */
  selectedPageId?: string;
  /** Row keys (`folder:<id>` / `page:<id>`) open on first paint, root-first. */
  expandedPath?: LevelKey[];
  /** Levels the server already read for `expandedPath`, by key; any missing one is read on mount. */
  initialLevels?: Record<LevelKey, PageTreeLevelDto>;
  /** The row scrolled into view and made the tab stop once it is shown; the selected page's by default. */
  revealKey?: LevelKey;
  /** Also move focus to `revealKey`'s row once it is shown (`/pages?folder=<id>`). */
  focusRevealed?: boolean;
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
  folderActions,
  canEditFolders = false,
  selectedPageId,
  expandedPath,
  initialLevels,
  revealKey,
  focusRevealed = false,
}: PageTreeProps) {
  const t = useTranslations('pages.tree');
  const tc = useTranslations('common');
  const ti = useTranslations('pages.index');
  const tp = useTranslations('pages');
  const tf = useTranslations('folders');
  const tv = useTranslations('issueViews');
  const { toast } = useToast();
  const { pending, create } = useCreatePage();
  const foldersEditable = canEdit && canEditFolders && folderActions !== undefined;
  const metrics = DENSITY[density];

  const [levels, setLevels] = useState<Record<LevelKey, LevelState>>(() => ({
    ...Object.fromEntries(
      Object.entries(initialLevels ?? {}).map(([key, level]) => [
        key,
        { ...FRESH, rows: level.rows, nextCursor: level.nextCursor },
      ]),
    ),
    [ROOT_LEVEL]:
      initialRoot === undefined
        ? { ...FRESH, loading: 'initial' }
        : initialRoot === null
          ? { ...FRESH, failed: 'initial' }
          : { ...FRESH, rows: initialRoot.rows, nextCursor: initialRoot.nextCursor },
  }));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(expandedPath ?? []));
  const levelSeq = useRef<Record<LevelKey, number>>({});

  // ⚠️ THE ONE PLACE A LEVEL IS READ. `more` appends after the level's cursor;
  // otherwise the level is read from its start and replaces what was there.
  // `size` lets a RE-READ keep what was loaded (up to the route's ceiling). A
  // re-read of a level that already shows rows keeps them on screen while it
  // runs — it is a refresh, not a first read, so no loading row replaces them.
  const read = useCallback(
    async (level: LevelKey, more: boolean, cursor: string | null, size = PAGE_LEVEL_SIZE) => {
      const seq = (levelSeq.current[level] ?? 0) + 1;
      levelSeq.current[level] = seq;
      setLevels((prev) => {
        const current = prev[level] ?? FRESH;
        const refreshing = !more && current.rows.length > 0 && current.failed === null;
        return {
          ...prev,
          [level]: {
            ...current,
            loading: refreshing ? current.loading : more ? 'more' : 'initial',
            failed: null,
          },
        };
      });
      const query = new URLSearchParams({ parent: level, limit: String(size) });
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

  // ── Re-reading the levels a write changed (MOTIR-7374) ─────────────────────
  // Each named level that is LOADED is read again from its start, keeping as
  // many rows as it showed; so is the level holding its OWNER row, so a page
  // that gained or lost its last sub-page shows or drops its chevron. A level
  // never read stays unread — its first expand reads it fresh.
  const levelsRef = useRef(levels);
  useEffect(() => {
    levelsRef.current = levels;
  }, [levels]);
  const refreshLevels = useCallback(
    (keys: LevelKey[]) => {
      const current = levelsRef.current;
      const all = new Set<LevelKey>();
      for (const key of keys) {
        all.add(key);
        if (key === ROOT_LEVEL) continue;
        const holder = Object.keys(current).find((level) =>
          current[level]!.rows.some((row) => rowKey(row) === key),
        );
        if (holder) all.add(holder);
      }
      for (const key of all) {
        const level = current[key];
        if (!level) continue;
        const size = Math.min(PAGE_LEVEL_SIZE_MAX, Math.max(PAGE_LEVEL_SIZE, level.rows.length));
        void read(key, false, null, size);
      }
    },
    [read],
  );
  const { move } = usePageMove({ refresh: refreshLevels });

  // The root when the server did not read it, and every open level of the
  // arrival path the server did not hand in — read once, on mount.
  const readOnMount = useRef<LevelKey[] | null>([
    ...(initialRoot === undefined ? [ROOT_LEVEL] : []),
    ...(expandedPath ?? []).filter((key) => key !== ROOT_LEVEL && !initialLevels?.[key]),
  ]);
  useEffect(() => {
    const keys = readOnMount.current;
    if (!keys) return;
    readOnMount.current = null;
    for (const key of keys) void read(key, false, null);
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

  /** Open a row's level (reading it if it never was), leaving an open one open. */
  const reveal = useCallback(
    (key: LevelKey) => {
      if (key === ROOT_LEVEL) return;
      setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      const level = levelsRef.current[key];
      if (!level || level.failed) void read(key, false, null);
    },
    [read],
  );

  // ── Moving a page (MOTIR-7374) ─────────────────────────────────────────────
  const [picker, setPicker] = useState<PickerState | null>(null);
  const pickerSeq = useRef(0);
  const closePicker = useCallback(() => {
    pickerSeq.current += 1;
    setPicker(null);
  }, []);

  const openPagePicker = useCallback(
    (row: PageTreePageRowDto, levelKey: LevelKey) => {
      pickerSeq.current += 1;
      setPicker({
        kind: 'page',
        pageId: row.id,
        title: row.title || tp('untitled'),
        levelKey,
        refusal: null,
        pending: false,
        epoch: 0,
      });
    },
    [tp],
  );

  // Picking commits: the page leaves its level and joins the target, and the
  // target opens so the result is in view. A refusal renders at the picker's
  // top and the tree is untouched; `gone` also re-opens the list fresh.
  const pickPagePlacement = useCallback(
    async (target: PageParentDto) => {
      const current = picker;
      if (!current || current.kind !== 'page' || current.pending) return;
      const openSeq = pickerSeq.current;
      setPicker((p) => (p && p.kind === 'page' ? { ...p, pending: true } : p));
      const outcome = await move({
        pageId: current.pageId,
        from: current.levelKey,
        parent: target,
      });
      if (outcome === null || pickerSeq.current !== openSeq) return;
      if (outcome.ok) {
        closePicker();
        reveal(parentKey(outcome.result.parent));
        return;
      }
      setPicker((p) =>
        p && p.kind === 'page' && p.pageId === current.pageId
          ? {
              ...p,
              pending: false,
              refusal: outcome.message,
              epoch: outcome.refusal === 'gone' ? p.epoch + 1 : p.epoch,
            }
          : p,
      );
    },
    [picker, move, closePicker, reveal],
  );

  // Move up / Move down: a refusal is the move's own sentence, as a toast.
  const reorderPage = useCallback(
    async (
      row: PageTreePageRowDto,
      levelKey: LevelKey,
      siblings: string[],
      direction: 'up' | 'down',
    ) => {
      const neighbours = reorderNeighbours(siblings, row.id, direction);
      if (!neighbours) return;
      const outcome = await move({
        pageId: row.id,
        from: levelKey,
        parent: parentOf(levelKey),
        ...neighbours,
      });
      if (outcome && !outcome.ok) toast({ variant: 'error', title: outcome.message });
    },
    [move, toast],
  );

  // ── The folder commands (MOTIR-7374) — `/items`' shipped behaviour ────────
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const draftSeq = useRef(0);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const deleteSeq = useRef(0);
  const folderActionSeq = useRef<Record<string, number>>({});

  /** Start one write for `folderId`; the returned check says whether it is still the latest. */
  const beginFolderAction = useCallback((folderId: string) => {
    const seq = (folderActionSeq.current[folderId] ?? 0) + 1;
    folderActionSeq.current[folderId] = seq;
    return () => folderActionSeq.current[folderId] === seq;
  }, []);

  const transportFailed = useCallback(
    (err: unknown) => toast({ variant: 'error', title: tv(serverActionRejectionKey(err)) }),
    [toast, tv],
  );

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
    () => openDraft({ mode: 'create', levelKey: ROOT_LEVEL, parentFolderId: null }),
    [openDraft],
  );

  // The header's (and the empty state's) New folder reaches this island through
  // the shared command channel; a request made before the tree mounted is held.
  const folderCommands = useFolderCommands();
  useEffect(() => {
    if (!folderCommands || !foldersEditable) return;
    folderCommands.registerNewRootFolder(startRootCreate);
    return () => folderCommands.registerNewRootFolder(null);
  }, [folderCommands, foldersEditable, startRootCreate]);

  const submitDraft = useCallback(
    async (raw: string) => {
      if (!draft || !folderActions) return;
      const name = raw.trim();
      if (name.length === 0) {
        setDraftError(tf('nameRequired'));
        return;
      }
      const current = draft;
      const seq = ++draftSeq.current;
      setDraftPending(true);
      let res: Awaited<ReturnType<FolderCommandActions['createFolder']>>;
      try {
        res =
          current.mode === 'create'
            ? await folderActions.createFolder({ parentFolderId: current.parentFolderId, name })
            : await folderActions.renameFolder({ folderId: current.folderId, name });
      } catch (err) {
        if (draftSeq.current !== seq) return;
        setDraftPending(false);
        transportFailed(err);
        return;
      }
      if (draftSeq.current !== seq) return; // the row was closed or replaced meanwhile
      setDraftPending(false);
      if (!res.ok) {
        if (res.code === 'FOLDER_NAME_TAKEN') setDraftError(tf('nameTaken', { name }));
        else if (res.code === 'INVALID_FOLDER_NAME') setDraftError(tf('nameRequired'));
        else toast({ variant: 'error', title: res.error });
        return;
      }
      setDraft(null);
      setDraftError(null);
      const folder = res.folder;
      if (current.mode === 'create') {
        // The new folder joins its level in place, after the level's folders —
        // where a create appends it — and any read of that level still in flight
        // (taken before the folder existed) is retired.
        const levelKey = current.levelKey;
        levelSeq.current[levelKey] = (levelSeq.current[levelKey] ?? 0) + 1;
        setLevels((prev) => {
          const level = prev[levelKey] ?? FRESH;
          const row: PageTreeRowDto = {
            kind: 'folder',
            id: folder.id,
            name: folder.name,
            hasChildren: false,
          };
          const at = level.rows.filter((r) => r.kind === 'folder').length;
          return {
            ...prev,
            [levelKey]: {
              ...level,
              rows: [...level.rows.slice(0, at), row, ...level.rows.slice(at)],
              loading: null,
            },
          };
        });
      } else {
        // A rename replaces the name wherever the folder is loaded, in place.
        setLevels((prev) => {
          const next = { ...prev };
          for (const [key, level] of Object.entries(prev)) {
            if (level.rows.some((r) => r.kind === 'folder' && r.id === folder.id)) {
              next[key] = {
                ...level,
                rows: level.rows.map((r) =>
                  r.kind === 'folder' && r.id === folder.id ? { ...r, name: folder.name } : r,
                ),
              };
            }
          }
          return next;
        });
      }
    },
    [draft, folderActions, tf, toast, transportFailed],
  );

  const loadPickerFolders = useCallback(
    async (folderId: string, seq: number) => {
      if (!folderActions) return;
      let res: Awaited<ReturnType<FolderCommandActions['listProjectFolders']>>;
      try {
        res = await folderActions.listProjectFolders();
      } catch (err) {
        if (pickerSeq.current !== seq) return;
        setPicker(null);
        transportFailed(err);
        return;
      }
      if (pickerSeq.current !== seq) return;
      setPicker((p) =>
        p && p.kind === 'folder' && p.folderId === folderId
          ? res.ok
            ? { ...p, folders: res.data.folders, truncated: res.data.truncated }
            : { ...p, folders: [], truncated: false, refusal: res.error }
          : p,
      );
    },
    [folderActions, transportFailed],
  );

  const openFolderPicker = useCallback(
    (row: PageTreeFolderRowDto, levelKey: LevelKey) => {
      const seq = ++pickerSeq.current;
      setPicker({
        kind: 'folder',
        folderId: row.id,
        name: row.name,
        levelKey,
        parentFolderId: folderParentOf(levelKey),
        folders: null,
        truncated: false,
        refusal: null,
        pending: false,
      });
      void loadPickerFolders(row.id, seq);
    },
    [loadPickerFolders],
  );

  const pickFolderDestination = useCallback(
    async (targetId: string | null) => {
      const current = picker;
      if (!current || current.kind !== 'folder' || current.pending || !folderActions) return;
      const isLatest = beginFolderAction(current.folderId);
      const openSeq = pickerSeq.current;
      setPicker((p) => (p ? { ...p, pending: true } : p));
      let res: FolderActionResult;
      try {
        res = await folderActions.moveFolder({
          folderId: current.folderId,
          targetParentFolderId: targetId,
        });
      } catch (err) {
        if (!isLatest()) return;
        setPicker((p) => (p && p.kind === 'folder' ? { ...p, pending: false } : p));
        transportFailed(err);
        return;
      }
      if (!isLatest()) return;
      if (res.ok) {
        closePicker();
        const to = targetId === null ? ROOT_LEVEL : parentKey({ kind: 'folder', id: targetId });
        refreshLevels([current.levelKey, to]);
        return;
      }
      // A refusal the picker could not have known about: say why at its top and
      // re-read the list, so it shows the folders as they now are.
      const refusal =
        res.code === 'FOLDER_CYCLE'
          ? tf('cycleRefused')
          : res.code === 'CROSS_PROJECT_FOLDER'
            ? tf('crossProjectRefused')
            : res.code === 'FOLDER_NAME_TAKEN'
              ? tf('nameTaken', { name: current.name })
              : res.code === 'FOLDER_NOT_FOUND'
                ? tf('folderGone')
                : null;
      if (refusal === null) {
        setPicker((p) => (p && p.kind === 'folder' ? { ...p, pending: false } : p));
        toast({ variant: 'error', title: res.error });
        return;
      }
      if (pickerSeq.current !== openSeq) return;
      setPicker((p) =>
        p && p.kind === 'folder' ? { ...p, pending: false, refusal, folders: null } : p,
      );
      void loadPickerFolders(current.folderId, openSeq);
    },
    [
      picker,
      folderActions,
      beginFolderAction,
      transportFailed,
      closePicker,
      refreshLevels,
      tf,
      toast,
      loadPickerFolders,
    ],
  );

  const reorderFolder = useCallback(
    async (
      row: PageTreeFolderRowDto,
      levelKey: LevelKey,
      siblings: string[],
      direction: 'up' | 'down',
    ) => {
      if (!folderActions) return;
      const k = siblings.indexOf(row.id);
      if (k < 0 || (direction === 'up' && k === 0)) return;
      if (direction === 'down' && k === siblings.length - 1) return;
      // `beforeId` is the sibling it will sort AFTER, `afterId` the one it sorts BEFORE.
      const beforeId = direction === 'up' ? (siblings[k - 2] ?? null) : (siblings[k + 1] ?? null);
      const afterId = direction === 'up' ? (siblings[k - 1] ?? null) : (siblings[k + 2] ?? null);
      const isLatest = beginFolderAction(row.id);
      let res: FolderActionResult;
      try {
        res = await folderActions.moveFolder({
          folderId: row.id,
          targetParentFolderId: folderParentOf(levelKey),
          beforeId,
          afterId,
        });
      } catch (err) {
        if (isLatest()) transportFailed(err);
        return;
      }
      if (!isLatest()) return;
      if (!res.ok) {
        toast({ variant: 'error', title: res.error });
        return;
      }
      refreshLevels([levelKey]);
    },
    [folderActions, beginFolderAction, transportFailed, toast, refreshLevels],
  );

  const closeDelete = useCallback(() => {
    deleteSeq.current += 1;
    setDeleting(null);
  }, []);

  // A deleted folder's row leaves its level in place.
  const removeFolderRow = useCallback((folderId: string, levelKey: LevelKey) => {
    levelSeq.current[levelKey] = (levelSeq.current[levelKey] ?? 0) + 1;
    setLevels((prev) => {
      const level = prev[levelKey];
      if (!level) return prev;
      return {
        ...prev,
        [levelKey]: {
          ...level,
          rows: level.rows.filter((r) => !(r.kind === 'folder' && r.id === folderId)),
          loading: null,
        },
      };
    });
  }, []);

  // Opening the dialog COUNTS what the delete would move — folders, work items
  // and pages (MOTIR-7371); until that answers it shows no number and cannot be
  // confirmed.
  const openDelete = useCallback(
    async (row: PageTreeFolderRowDto, levelKey: LevelKey) => {
      if (!folderActions) return;
      const seq = ++deleteSeq.current;
      setDeleting({
        folderId: row.id,
        name: row.name,
        levelKey,
        preview: null,
        refusal: null,
        pending: false,
      });
      let res: Awaited<ReturnType<FolderCommandActions['describeFolderDeletion']>>;
      try {
        res = await folderActions.describeFolderDeletion({ folderId: row.id });
      } catch (err) {
        if (deleteSeq.current !== seq) return;
        setDeleting(null);
        transportFailed(err);
        return;
      }
      if (deleteSeq.current !== seq) return;
      if (res.ok) {
        const preview = res.preview;
        setDeleting((d) => (d && d.folderId === row.id ? { ...d, preview } : d));
        return;
      }
      setDeleting(null);
      if (res.code === 'FOLDER_NOT_FOUND') removeFolderRow(row.id, levelKey);
      else toast({ variant: 'error', title: res.error });
    },
    [folderActions, transportFailed, toast, removeFolderRow],
  );

  // Confirming deletes; the row leaves its level and that level is re-read, so
  // the folders and pages that moved up appear in their stored order.
  const confirmDelete = useCallback(async () => {
    const current = deleting;
    if (!current || current.preview === null || current.pending || !folderActions) return;
    const seq = deleteSeq.current;
    setDeleting((d) => (d ? { ...d, pending: true, refusal: null } : d));
    let res: Awaited<ReturnType<FolderCommandActions['deleteFolder']>>;
    try {
      res = await folderActions.deleteFolder({ folderId: current.folderId });
    } catch (err) {
      if (deleteSeq.current !== seq) return;
      setDeleting((d) => (d ? { ...d, pending: false } : d));
      transportFailed(err);
      return;
    }
    if (deleteSeq.current !== seq) return;
    if (res.ok || res.code === 'FOLDER_NOT_FOUND') {
      closeDelete();
      removeFolderRow(current.folderId, current.levelKey);
      if (res.ok) refreshLevels([current.levelKey]);
      return;
    }
    const refusal =
      res.code === 'FOLDER_NAME_TAKEN'
        ? tf('deleteNameTaken', { name: res.folderName ?? '' })
        : res.code === 'SUBTASK_NEEDS_PLACEMENT'
          ? tf('deleteSubtaskNeedsPlacement')
          : null;
    if (refusal === null) {
      setDeleting((d) => (d ? { ...d, pending: false } : d));
      toast({ variant: 'error', title: res.error });
      return;
    }
    setDeleting((d) => (d ? { ...d, pending: false, refusal } : d));
  }, [
    deleting,
    folderActions,
    transportFailed,
    closeDelete,
    removeFolderRow,
    refreshLevels,
    tf,
    toast,
  ]);

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
      // An open NEW-folder name row sits first in its level (panel 2).
      const naming = draft?.mode === 'create' && draft.levelKey === level;
      if (naming) out.push({ type: 'draft', key: `draft:${level}`, depth });
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
      if (state.rows.length === 0 && level !== ROOT_LEVEL && pendingLevel !== level && !naming) {
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
  }, [levels, expanded, pendingLevel, draft]);

  // ── Focus: one row in the tab order ───────────────────────────────────────
  const rowItems = useMemo(
    () => items.flatMap((item, index) => (item.type === 'row' ? [{ item, index }] : [])),
    [items],
  );
  const selectedKey = selectedPageId ? `page:${selectedPageId}` : null;
  const revealTarget = revealKey ?? selectedKey;
  const [focusedKey, setFocusedKey] = useState<string | null>(revealTarget);
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

  /** Scroll a row that is off the window to the middle of its scroller. */
  const scrollToRow = useCallback(
    (key: string) => {
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
      scrollToRow(key);
    },
    [scrollToRow],
  );

  // The arrival row (MOTIR-7375): once it is shown — the path may still be
  // reading — scroll it into view, and focus it when asked. Once only, so the
  // reader's own scrolling and focus are never taken back.
  const revealed = useRef(revealTarget === null);
  useEffect(() => {
    if (revealed.current || revealTarget === null) return;
    if (!rowItems.some(({ item }) => item.key === revealTarget)) return;
    revealed.current = true;
    // The row is already the tab stop (`focusedKey` starts at it), so this only
    // touches the DOM: focus it — once it mounts, if it is off the window — or
    // scroll it into view.
    const el = rowRefs.current.get(revealTarget);
    if (el) {
      if (focusRevealed) el.focus();
      else el.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (focusRevealed) pendingFocus.current = revealTarget;
    scrollToRow(revealTarget);
  }, [rowItems, revealTarget, focusRevealed, scrollToRow]);

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

  // ── The row menus ─────────────────────────────────────────────────────────
  /** A level's loaded sibling ids of one kind, in order — what Move up / down reason about. */
  const siblingIds = (levelKey: LevelKey, kind: PageTreeRowDto['kind']) =>
    (levels[levelKey]?.rows ?? []).filter((r) => r.kind === kind).map((r) => r.id);

  // A page row: New sub-page · Move to… | Move up · Move down — the edge entries
  // ABSENT on the first / last sibling page (MOTIR-7374).
  const pageMenu = (row: PageTreePageRowDto, levelKey: LevelKey): ReactNode | null => {
    if (!canEdit) return null;
    const siblings = siblingIds(levelKey, 'page');
    const at = siblings.indexOf(row.id);
    const open = picker?.kind === 'page' && picker.pageId === row.id;
    return (
      <PageRowMenu
        title={row.title || tp('untitled')}
        onNewSubPage={() => void create({ kind: 'page', id: row.id })}
        onMoveTo={() => openPagePicker(row, levelKey)}
        onMoveUp={at > 0 ? () => void reorderPage(row, levelKey, siblings, 'up') : undefined}
        onMoveDown={
          at >= 0 && at < siblings.length - 1
            ? () => void reorderPage(row, levelKey, siblings, 'down')
            : undefined
        }
        extraEntries={pageMenuEntries?.(row)}
        pickerOpen={open}
        onPickerOpenChange={(next) => {
          if (!next) closePicker();
        }}
        picker={
          open && picker?.kind === 'page' ? (
            <PagePlacementPicker
              key={picker.epoch}
              pageId={picker.pageId}
              title={picker.title}
              currentParent={parentOf(picker.levelKey)}
              projectKey={projectKey}
              refusal={picker.refusal}
              pending={picker.pending}
              onPick={(target) => void pickPagePlacement(target)}
              onDismiss={closePicker}
            />
          ) : null
        }
      />
    );
  };

  // A folder row: New page here, then — for a reader who may write folders — the
  // shipped `/items` folder commands (`PageTreeFolderMenu`).
  const folderMenu = (row: PageTreeFolderRowDto, levelKey: LevelKey): ReactNode | null => {
    if (!canEdit) return null;
    const siblings = siblingIds(levelKey, 'folder');
    const at = siblings.indexOf(row.id);
    const key = rowKey(row);
    const open = picker?.kind === 'folder' && picker.folderId === row.id;
    return (
      <PageTreeFolderMenu
        name={row.name}
        onNewPageHere={() => void create({ kind: 'folder', id: row.id })}
        commands={
          foldersEditable
            ? {
                onNewFolderInside: () => {
                  reveal(key);
                  openDraft({ mode: 'create', levelKey: key, parentFolderId: row.id });
                },
                onRename: () => openDraft({ mode: 'rename', folderId: row.id }),
                onMoveTo: () => openFolderPicker(row, levelKey),
                onMoveUp: () => void reorderFolder(row, levelKey, siblings, 'up'),
                onMoveDown: () => void reorderFolder(row, levelKey, siblings, 'down'),
                onDelete: () => void openDelete(row, levelKey),
                isFirst: at <= 0,
                isLast: at < 0 || at === siblings.length - 1,
              }
            : undefined
        }
        extraEntries={folderMenuEntries?.(row)}
        pickerOpen={open}
        onPickerOpenChange={(next) => {
          if (!next) closePicker();
        }}
        picker={
          open && picker?.kind === 'folder' ? (
            <FolderPickerPanel
              mode="move"
              title={tf('pickerTitle', { name: picker.name })}
              folders={picker.folders}
              truncated={picker.truncated}
              currentFolderId={picker.parentFolderId}
              movingFolderId={picker.folderId}
              refusal={picker.refusal}
              pending={picker.pending}
              onPick={(target) => void pickFolderDestination(target)}
              onDismiss={closePicker}
            />
          ) : null
        }
      />
    );
  };

  const nameField = (initialName: string) => (
    <FolderNameField
      initialName={initialName}
      error={draftError}
      pending={draftPending}
      onSubmit={(name) => void submitDraft(name)}
      onCancel={cancelDraft}
      onEdit={clearDraftError}
    />
  );

  // ── The whole-tree states ─────────────────────────────────────────────────
  const root = levels[ROOT_LEVEL]!;
  const compact = density === 'compact';
  // The sidebar sits on its own column's surface — no card around it.
  const frame = compact
    ? ''
    : 'overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)';

  if (root.failed === 'initial') {
    return (
      <div
        className={frame}
        data-surface={compact ? undefined : 'card'}
        data-testid="page-tree-failed"
      >
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
    root.loading === null &&
    root.rows.length === 0 &&
    root.nextCursor === null &&
    !pending &&
    !(draft?.mode === 'create' && draft.levelKey === ROOT_LEVEL);
  const dialog = deleting ? (
    <FolderDeleteDialog
      folderName={deleting.name}
      preview={deleting.preview}
      refusal={deleting.refusal}
      pending={deleting.pending}
      onConfirm={() => void confirmDelete()}
      onCancel={closeDelete}
    />
  ) : null;
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
          density={density}
          menu={folderMenu(item.row, item.parent ?? ROOT_LEVEL)}
          nameField={
            draft?.mode === 'rename' && draft.folderId === item.row.id
              ? nameField(item.row.name)
              : undefined
          }
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
          menu={pageMenu(item.row, item.parent ?? ROOT_LEVEL)}
          selected={item.key === selectedKey}
          density={density}
        />
      );
    }

    const synthetic = 'flex items-center gap-2 pr-2 text-[13px] text-(--el-text-secondary)';
    const slot = <span className="h-4 w-4 shrink-0" aria-hidden />;
    let body: ReactNode;
    switch (item.type) {
      case 'draft':
        return (
          <div
            key={item.key}
            ref={measure}
            role="none"
            data-testid="page-tree-folder-draft"
            className="flex items-center gap-2 pr-2 text-sm"
            style={style}
          >
            {slot}
            <Folder className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            {nameField('')}
          </div>
        );
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
    <>
      <div className={frame} data-surface={compact ? undefined : 'card'}>
        <div
          ref={containerRef}
          role="tree"
          aria-label={compact ? t('sidebar.label') : t('label')}
          className={compact ? undefined : 'divide-y divide-(--el-border-soft)'}
          style={windowing ? { position: 'relative', height: totalSize } : undefined}
        >
          {items.slice(range.start, range.end).map((item, i) => renderItem(item, range.start + i))}
        </div>
      </div>
      {dialog}
    </>
  );
}
