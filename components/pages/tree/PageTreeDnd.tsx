'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ArrowUp, GripVertical, NotebookText } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { PageParentDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ROOT_LEVEL, parentKey, parentOf, type LevelKey } from './pageTreeRow';
import type { PageMoveRequest } from './usePageMove';

// DRAG-AND-DROP IN THE PAGE TREE (Story MOTIR-5753 · MOTIR-7376) —
// `design/pages/pages--tree.mock.html` panel 11 and `design-notes.md` § The page
// tree, "Drag". A second way to do what Move to… / Move up / Move down already
// do: every drop is ONE `usePageMove` call (MOTIR-7374), so its refusal
// sentences, its per-page sequence guard and its level re-reads are the same.
//
// ── WHAT DRAGS, WHAT RECEIVES ──────────────────────────────────────────────
// Only PAGE rows drag, and only for an editor; FOLDER rows are drop targets and
// never drag (a folder moves with Move to…, as in `/items`). The whole page row
// is the draggable — the `GripVertical` handle in its gutter is a hint, so it is
// `aria-hidden` and out of the tab order. There is NO keyboard drag: Move up /
// Move down / Move to… are the keyboard path, so the only sensor is the pointer
// (8px activation, so a click on the title, chevron or menu never starts one).
//
// ── THE BANDS ──────────────────────────────────────────────────────────────
// On a page row the top quarter means BEFORE, the bottom quarter AFTER and the
// middle half INSIDE; a folder row is INSIDE only (`dropZoneAt`). The band is
// read from the POINTER (its start plus the drag's delta) against the hovered
// row's measured rect — never from the overlay's rect, which lags the pointer by
// the grab offset. While a drag is live a ROOT zone sits at the tree's foot:
// dropping there moves the page to the project root, after the root's pages.
//
// ── REFUSED BEFORE THE DROP ────────────────────────────────────────────────
// A page over itself or over anything inside it (whatever the band — a sibling
// of a sub-page is still inside the subtree) is refused HERE, so the server is
// never asked: the row is drawn with the dashed danger outline, the lifted row
// says why in a tooltip, and releasing sends nothing. Depth and cross-project
// refusals only the server knows; those come back from `usePageMove` and the
// tree says them in a toast.
//
// ── SNAP-BACK ──────────────────────────────────────────────────────────────
// Nothing is moved before the server answers (MOTIR-7374's hook), so the source
// row never leaves its place: it is drawn as the dashed ORIGIN SLOT while the
// lifted copy rides the `DragOverlay`, and on release the overlay's drop
// animation flies back to it. A refusal therefore leaves the tree exactly as it
// was; a success re-reads the source and target levels.
//
// ── WINDOWED, LAZY ROWS ────────────────────────────────────────────────────
// Only the mounted rows of the windowed tree register as droppables, and the
// tree's layout changes mid-drag (a hovered collapsed row opens after 600ms), so
// droppables are re-measured on every change (`MeasuringStrategy.Always`).

export type DropZone = 'before' | 'inside' | 'after';

/** What a hovered row shows: a band, or the dashed refusal. */
export type DropMark = DropZone | 'refused';

/** The droppable id of the root zone at the tree's foot. */
export const ROOT_DROP_ID = 'page-tree-drop:root';

/** How long a collapsed row must be hovered before it opens (design-notes § Drag). */
export const HOVER_EXPAND_MS = 600;

/**
 * The band a pointer at `y` means over a row: a folder row is INSIDE only; on a
 * page row the top quarter is BEFORE, the bottom quarter AFTER, the middle half
 * INSIDE.
 */
export function dropZoneAt(
  kind: PageTreeRowDto['kind'],
  rect: { top: number; height: number },
  y: number,
): DropZone {
  if (kind === 'folder' || rect.height <= 0) return 'inside';
  const at = (y - rect.top) / rect.height;
  if (at < 0.25) return 'before';
  if (at > 0.75) return 'after';
  return 'inside';
}

/** A visible row as the drag reasons about it — `PageTree`'s flattened row. */
export interface DndRowInfo {
  key: LevelKey;
  row: PageTreeRowDto;
  /** The row key of the row this one sits under; `null` at the root. */
  parent: LevelKey | null;
  expandable: boolean;
  expanded: boolean;
}

/** Where a drop lands. */
export type DropTarget = { kind: 'row'; info: DndRowInfo; zone: DropZone } | { kind: 'root' };

/** What releasing over a target does. */
export type DropPlan =
  | { kind: 'refused' }
  | { kind: 'none' }
  | { kind: 'move'; parent: PageParentDto; beforeId: string | null; afterId: string | null };

/** Whether `key` is the page `pageId` or sits anywhere under it in the visible tree. */
export function inSubtree(
  pageId: string,
  key: LevelKey,
  parentByKey: ReadonlyMap<LevelKey, LevelKey | null>,
): boolean {
  const self = `page:${pageId}`;
  let at: LevelKey | null | undefined = key;
  const seen = new Set<LevelKey>();
  while (at && !seen.has(at)) {
    if (at === self) return true;
    seen.add(at);
    at = parentByKey.get(at);
  }
  return false;
}

export interface PlanPageDropInput {
  /** The page being dragged. */
  pageId: string;
  /** The level it sits in now. */
  from: LevelKey;
  target: DropTarget;
  parentByKey: ReadonlyMap<LevelKey, LevelKey | null>;
  /** A level's loaded sibling PAGE ids, in order. */
  levelPages: (level: LevelKey) => readonly string[];
}

/**
 * The placement a drop asks for, in `usePageMove`'s neighbour shape (`beforeId`
 * — the page it lands right AFTER; `afterId` — the page it lands right BEFORE).
 * One side is named and the server reads the other from the level, so a sibling
 * that is not loaded is never guessed at. A drop that would leave the page where
 * it is sends nothing (`none`); a drop into its own subtree is `refused`.
 */
export function planPageDrop({
  pageId,
  from,
  target,
  parentByKey,
  levelPages,
}: PlanPageDropInput): DropPlan {
  if (target.kind === 'root') {
    if (from !== ROOT_LEVEL)
      return { kind: 'move', parent: { kind: 'root' }, beforeId: null, afterId: null };
    const pages = levelPages(ROOT_LEVEL);
    const last = pages[pages.length - 1];
    if (last === undefined || last === pageId) return { kind: 'none' };
    return { kind: 'move', parent: { kind: 'root' }, beforeId: last, afterId: null };
  }

  const { info, zone } = target;
  if (inSubtree(pageId, info.key, parentByKey)) return { kind: 'refused' };

  if (zone === 'inside' || info.row.kind === 'folder') {
    const parent: PageParentDto =
      info.row.kind === 'folder'
        ? { kind: 'folder', id: info.row.id }
        : { kind: 'page', id: info.row.id };
    if (parentKey(parent) === from) return { kind: 'none' };
    return { kind: 'move', parent, beforeId: null, afterId: null };
  }

  const level = info.parent ?? ROOT_LEVEL;
  const parent = parentOf(level);
  if (level === from) {
    const pages = levelPages(level);
    const self = pages.indexOf(pageId);
    const over = pages.indexOf(info.row.id);
    if (self >= 0 && over >= 0) {
      if (zone === 'before' && self === over - 1) return { kind: 'none' };
      if (zone === 'after' && self === over + 1) return { kind: 'none' };
    }
  }
  return zone === 'before'
    ? { kind: 'move', parent, beforeId: null, afterId: info.row.id }
    : { kind: 'move', parent, beforeId: info.row.id, afterId: null };
}

// ── The provider ────────────────────────────────────────────────────────────

interface DndState {
  /** The dragged row's key, while a drag is live. */
  activeKey: LevelKey | null;
  /** The hovered target and what it shows. */
  over: { key: LevelKey; mark: DropMark } | null;
}

const PageTreeDndContext = createContext<DndState>({ activeKey: null, over: null });

/** The live drag, for the rows and the root zone. */
export function usePageTreeDnd(): DndState {
  return useContext(PageTreeDndContext);
}

export interface PageTreeDndProps {
  /** The visible rows, in order — the tree's flattened rows. */
  rows: readonly DndRowInfo[];
  /** A level's loaded sibling PAGE ids, in order. */
  levelPages: (level: LevelKey) => readonly string[];
  /** Open a collapsed row hovered for `HOVER_EXPAND_MS`. */
  onExpand: (key: LevelKey) => void;
  /** Commit a drop — `usePageMove` through the tree, which says a refusal. */
  onCommit: (request: PageMoveRequest) => void;
  /** The lifted row's height — the tree's row metrics. */
  rowPx: number;
  children: ReactNode;
}

/** The pointer's Y when the drag began — the activator's own event. */
function startY(event: DragStartEvent): number {
  const e = event.activatorEvent as { clientY?: unknown } | null;
  return typeof e?.clientY === 'number' ? e.clientY : 0;
}

// No keyboard drag (design-notes § Drag), so there is nothing to instruct and
// nothing to announce: the keyboard path is the row menu's Move entries. dnd-kit
// still portals its instructions and an (empty) `role="status"` live region, so
// they go to a DETACHED node rather than the page — an always-silent status in
// the accessibility tree is noise beside the tree's own status rows.
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

export function PageTreeDnd({
  rows,
  levelPages,
  onExpand,
  onCommit,
  rowPx,
  children,
}: PageTreeDndProps) {
  const t = useTranslations('pages.tree.drop');
  const tp = useTranslations('pages');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [state, setState] = useState<DndState>({ activeKey: null, over: null });

  const [a11yContainer] = useState<Element | undefined>(() =>
    typeof document === 'undefined' ? undefined : document.createElement('div'),
  );
  const rowsRef = useRef(rows);
  const levelPagesRef = useRef(levelPages);
  useEffect(() => {
    rowsRef.current = rows;
    levelPagesRef.current = levelPages;
  }, [rows, levelPages]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const byKeyRef = useRef(byKey);
  useEffect(() => {
    byKeyRef.current = byKey;
  }, [byKey]);

  const pointerStart = useRef(0);
  /** The target under the pointer, as last resolved — what a release commits. */
  const targetRef = useRef<DropTarget | null>(null);
  const hoverTimer = useRef<{ key: LevelKey; id: ReturnType<typeof setTimeout> } | null>(null);

  const stopHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current.id);
    hoverTimer.current = null;
  }, []);
  useEffect(() => stopHover, [stopHover]);

  const parentByKey = useCallback(
    () => new Map(rowsRef.current.map((r) => [r.key, r.parent] as const)),
    [],
  );

  const activePageId = (key: LevelKey | null) =>
    key && key.startsWith('page:') ? key.slice('page:'.length) : null;

  const track = useCallback(
    (event: DragMoveEvent) => {
      const pageId = activePageId(String(event.active.id));
      const over = event.over;
      if (!pageId || !over) {
        targetRef.current = null;
        stopHover();
        setState((s) => (s.over === null ? s : { ...s, over: null }));
        return;
      }
      const overId = String(over.id);
      let target: DropTarget | null = null;
      let mark: DropMark;
      if (overId === ROOT_DROP_ID) {
        target = { kind: 'root' };
        mark = 'inside';
      } else {
        const info = byKeyRef.current.get(overId);
        if (!info) {
          targetRef.current = null;
          setState((s) => (s.over === null ? s : { ...s, over: null }));
          return;
        }
        const y = pointerStart.current + event.delta.y;
        const zone = dropZoneAt(info.row.kind, over.rect, y);
        target = { kind: 'row', info, zone };
        mark = inSubtree(pageId, info.key, parentByKey()) ? 'refused' : zone;
        // A collapsed row hovered long enough opens, so a drop can go deeper.
        if (mark !== 'refused' && info.expandable && !info.expanded) {
          if (hoverTimer.current?.key !== info.key) {
            stopHover();
            const key = info.key;
            hoverTimer.current = {
              key,
              id: setTimeout(() => {
                hoverTimer.current = null;
                onExpand(key);
              }, HOVER_EXPAND_MS),
            };
          }
        } else {
          stopHover();
        }
      }
      if (target.kind === 'root') stopHover();
      targetRef.current = target;
      setState((s) =>
        s.over?.key === overId && s.over.mark === mark ? s : { ...s, over: { key: overId, mark } },
      );
    },
    [onExpand, parentByKey, stopHover],
  );

  const clear = useCallback(() => {
    stopHover();
    targetRef.current = null;
    setState({ activeKey: null, over: null });
  }, [stopHover]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    pointerStart.current = startY(event);
    targetRef.current = null;
    setState({ activeKey: String(event.active.id), over: null });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      track(event);
      const target = targetRef.current;
      const activeKey = String(event.active.id);
      clear();
      const pageId = activePageId(activeKey);
      const active = byKeyRef.current.get(activeKey);
      if (!pageId || !active || !target) return;
      const from = active.parent ?? ROOT_LEVEL;
      const plan = planPageDrop({
        pageId,
        from,
        target,
        parentByKey: parentByKey(),
        levelPages: levelPagesRef.current,
      });
      if (plan.kind !== 'move') return;
      onCommit({
        pageId,
        from,
        parent: plan.parent,
        beforeId: plan.beforeId,
        afterId: plan.afterId,
      });
    },
    [track, clear, parentByKey, onCommit],
  );

  const activeRow = state.activeKey ? byKey.get(state.activeKey) : undefined;
  const refused = state.over?.mark === 'refused';
  const title = activeRow?.row.kind === 'page' ? activeRow.row.title || tp('untitled') : '';

  return (
    <PageTreeDndContext.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragMove={track}
        onDragEnd={handleDragEnd}
        onDragCancel={clear}
        accessibility={{
          announcements: SILENT,
          screenReaderInstructions: { draggable: '' },
          container: a11yContainer,
        }}
      >
        {children}
        <DragOverlay>
          {activeRow ? (
            <div
              data-testid="page-tree-drag-overlay"
              className={refused ? 'cursor-not-allowed' : 'cursor-grabbing'}
            >
              <div
                className="flex w-[260px] items-center gap-2 rounded-(--radius-control) border border-(--el-border-strong) bg-(--el-card) px-(--spacing-control-x) text-sm text-(--el-text) shadow-(--shadow-elevated)"
                style={{ height: rowPx }}
                aria-hidden
              >
                <GripVertical className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
                <NotebookText className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
                <span className="min-w-0 truncate">{title}</span>
              </div>
              {refused ? (
                <div
                  role="tooltip"
                  className="mt-1 w-max max-w-[280px] rounded-(--radius-control) bg-(--el-tooltip-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs leading-[1.45] text-(--el-tooltip-text) shadow-(--shadow-elevated)"
                >
                  {t('refusedSelf')}
                </div>
              ) : null}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </PageTreeDndContext.Provider>
  );
}

// ── The rows' half ──────────────────────────────────────────────────────────

/**
 * The pointer listeners `useDraggable` hands a row: event name → handler, the
 * shape of `@dnd-kit/core`'s `SyntheticListenerMap` (`Record<string, Function>`),
 * which assigns to this without a cast.
 *
 * ⚠️ Spelled out here rather than imported, for TYPE-CHECK MEMORY. `RowDnd` is
 * exported, so whatever it names is written into this module's emitted `.d.ts`,
 * and every program that imports the module through the app project's
 * declarations — the tests project, via `tests/pages/pageTreeDnd.test.tsx` and
 * the row components — then loads the ~147 declaration files of `@dnd-kit/core`
 * and `@dnd-kit/utilities` behind that one name. That closure is what pushed
 * `tsconfig.tests.json` over the `assert-typecheck-headroom.mjs` line; this
 * file is the only emitted declaration that named dnd-kit, so keep it that way.
 */
type RowListeners = Record<string, CallableFunction>;

/** What a row draws for the drag — handed to `PageTreePageRow` / `PageTreeFolderRow`. */
export interface RowDnd {
  /** The row element is both the draggable (page rows) and the droppable. */
  setNodeRef: (el: HTMLElement | null) => void;
  /** The pointer listeners; absent on a row that does not drag (a folder). */
  listeners: RowListeners | undefined;
  /** Whether the row shows the drag handle in its gutter. */
  handle: boolean;
  /** This row is the one lifted — drawn as the dashed origin slot. */
  origin: boolean;
  /** What a hovered row shows, or `null`. */
  mark: DropMark | null;
}

/** Registers one row with the drag and hands its row component what to draw. */
export function PageTreeDndRow({
  rowKey,
  draggable,
  children,
}: {
  rowKey: LevelKey;
  draggable: boolean;
  children: (dnd: RowDnd) => ReactNode;
}) {
  const drag = useDraggable({ id: rowKey, disabled: !draggable });
  const drop = useDroppable({ id: rowKey });
  const { activeKey, over } = usePageTreeDnd();
  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );
  return (
    <>
      {children({
        setNodeRef,
        listeners: draggable ? drag.listeners : undefined,
        handle: draggable,
        origin: activeKey === rowKey,
        mark: activeKey !== null && over?.key === rowKey ? over.mark : null,
      })}
    </>
  );
}

/** The drag chrome a row adds to its own class list. */
export function rowDndClass(dnd: RowDnd | undefined): string {
  if (!dnd) return '';
  return cn(
    'group',
    dnd.origin &&
      'border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) hover:bg-(--el-surface-soft) [&>*]:invisible',
    !dnd.origin &&
      dnd.mark === 'inside' &&
      'bg-(--el-tint-lavender) ring-2 ring-(--el-accent) ring-inset hover:bg-(--el-tint-lavender)',
    !dnd.origin &&
      dnd.mark === 'refused' &&
      'cursor-not-allowed outline-2 -outline-offset-2 outline-(--el-danger) outline-dashed',
  );
}

/**
 * The handle and the before / after line a row draws — the handle in the left
 * gutter (shown on hover and focus, decorative), the line a 2px accent rule with
 * an 8px ring dot at the target level's indent, where the row's glyph starts.
 */
export function RowDndMarks({ dnd, glyphLeft }: { dnd: RowDnd | undefined; glyphLeft: number }) {
  if (!dnd) return null;
  const line = !dnd.origin && (dnd.mark === 'before' || dnd.mark === 'after') ? dnd.mark : null;
  return (
    <>
      {dnd.handle ? (
        <span
          aria-hidden
          data-testid="page-tree-drag-handle"
          className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <GripVertical className="h-4 w-4 text-(--el-icon-muted)" aria-hidden />
        </span>
      ) : null}
      {line ? (
        <span
          aria-hidden
          data-testid={`page-tree-drop-${line}`}
          className={cn(
            'pointer-events-none absolute right-2 z-10 h-0.5 bg-(--el-accent)',
            line === 'before' ? '-top-px' : '-bottom-px',
          )}
          style={{ left: glyphLeft }}
        >
          <span className="absolute -top-[3px] -left-1 h-2 w-2 rounded-full border-2 border-(--el-accent) bg-(--el-card)" />
        </span>
      ) : null}
    </>
  );
}

/** The root target at the tree's foot — drawn only while a drag is live. */
export function PageTreeRootDropZone() {
  const t = useTranslations('pages.tree.drop');
  const { activeKey, over } = usePageTreeDnd();
  const { setNodeRef } = useDroppable({ id: ROOT_DROP_ID, disabled: activeKey === null });
  if (activeKey === null) return null;
  const hot = over?.key === ROOT_DROP_ID;
  return (
    <div
      ref={setNodeRef}
      data-testid="page-tree-drop-root"
      className={cn(
        'mt-2 flex items-center gap-2 rounded-(--radius-control) border border-dashed border-(--el-border-strong) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] text-(--el-text-secondary)',
        hot && 'bg-(--el-tint-lavender) ring-2 ring-(--el-accent) ring-inset',
      )}
    >
      <ArrowUp className="h-3.5 w-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden />
      {t('root')}
    </div>
  );
}
