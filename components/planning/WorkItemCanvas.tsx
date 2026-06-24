'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { WorkItemNode } from './WorkItemNode';
import {
  NODE_H,
  NODE_W,
  STATUS_LABELS,
  breadcrumb,
  computeLevel,
  deterministicLayout,
  hasChildren,
  levelOf,
  searchMatches,
  type WorkItemCanvasDep,
  type WorkItemCanvasItem,
  type WorkItemCanvasStatus,
} from '@/lib/planning/workItemCanvasModel';

// The reusable WORK-ITEM CANVAS (Subtask 7.20.2 / MOTIR-1194) — the FOUNDATION
// visual presentation of a work-item tree (epics → stories → subtasks), composed
// once and reused by every planning surface: the planning workspace canvas pane
// (MOTIR-1193), the persistent roadmap (MOTIR-1011), and the onboarding post-plan
// canvas. It renders ONE drill level at a time on the shipped `PlanningCanvas`
// engine (MOTIR-1236) — the deterministic auto-layout + node/edge CONTENT +
// search-to-focus + drill-down breadcrumb + filters; the engine owns pan / zoom /
// drag / fit and the read-only edges.
//
// PRESENTATIONAL: the forest + dependency edges arrive as DATA (the roadmap read /
// workspace state) — it owns no fetching. Saved per-node positions + the drag
// persistence are the consumer's (passed via `positions` / `onNodeMove`, e.g. the
// 7.3.77 `useCanvasLayout`); absent them, nodes auto-layout deterministically and
// drag only for the session. SCALE is the drill-down model (design
// `design/roadmap/*` sheet 6): one level fills the screen, so a chain stays legible
// at any tree size — zoom-to-fit gives the current level's overview.

export interface WorkItemCanvasProps {
  items: WorkItemCanvasItem[];
  dependencies: WorkItemCanvasDep[];
  /** Saved per-node world positions (consumer-owned persistence); falls back to
   *  the deterministic auto-layout per node. */
  positions?: Record<string, { x: number; y: number }>;
  /** A node was dragged — forward to persistence (the 7.3.77 save seam). */
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** A LEAF node (no children, not drillable) was activated. */
  onSelect?: (id: string) => void;
  /** Start drilled at this node (e.g. a deep link). */
  initialFocusId?: string | null;
  loading?: boolean;
  error?: string | null;
  ariaLabel?: string;
}

const ROOT_LABEL = 'Plan';

export function WorkItemCanvas({
  items,
  dependencies,
  positions,
  onNodeMove,
  onSelect,
  initialFocusId = null,
  loading = false,
  error = null,
  ariaLabel = 'Work-item roadmap',
}: WorkItemCanvasProps) {
  const [focusId, setFocusId] = useState<string | null>(initialFocusId);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [statusFilter, setStatusFilter] = useState<Set<WorkItemCanvasStatus>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(
    {},
  );

  const searchRef = useRef<HTMLInputElement>(null);

  // `/` anywhere on the canvas focuses the search field (design: the `/` shortcut),
  // unless the user is already typing into a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const level = useMemo(
    () => computeLevel(items, dependencies, focusId),
    [items, dependencies, focusId],
  );
  const crumbs = useMemo(() => breadcrumb(items, focusId), [items, focusId]);
  const matchIds = useMemo(() => new Set(searchMatches(items, query)), [items, query]);

  // The deterministic layout for THIS level (input → identical positions); a saved
  // or in-session-dragged position overrides per node.
  const layout = useMemo(
    () =>
      deterministicLayout(
        level.nodes.map((n) => n.item.id),
        level.edges,
      ),
    [level],
  );

  const positionOf = useCallback(
    (id: string) => localPositions[id] ?? positions?.[id] ?? layout[id] ?? { x: 0, y: 0 },
    [localPositions, positions, layout],
  );

  const canvasNodes: CanvasNode[] = level.nodes.map((n) => ({
    id: n.item.id,
    ...positionOf(n.item.id),
    width: NODE_W,
    height: NODE_H,
  }));
  const canvasEdges: CanvasEdge[] = level.edges.map((e) => ({
    from: e.from,
    to: e.to,
    variant: e.variant,
  }));

  const drillableById = new Map(level.nodes.map((n) => [n.item.id, n.drillable]));
  const itemById = new Map(level.nodes.map((n) => [n.item.id, n.item]));
  const filterActive = statusFilter.size > 0;

  const handleMove = useCallback(
    (id: string, x: number, y: number) => {
      setLocalPositions((prev) => ({ ...prev, [id]: { x, y } }));
      onNodeMove?.(id, x, y);
    },
    [onNodeMove],
  );

  const handleActivate = useCallback(
    (id: string) => {
      // A node with children DRILLS in; a leaf is SELECTED (the drill-down model).
      if (hasChildren(items, id)) {
        setFocusId(id);
        setHighlightId(null);
      } else {
        onSelect?.(id);
      }
    },
    [items, onSelect],
  );

  const drillTo = useCallback((id: string | null) => {
    setFocusId(id);
    setHighlightId(null);
  }, []);

  const goBack = useCallback(() => {
    // Pop one crumb: the parent of the current focus (or the top level).
    const parentCrumb = crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.id ?? null) : null;
    drillTo(parentCrumb);
  }, [crumbs, drillTo]);

  const locate = useCallback(() => {
    const ms = searchMatches(items, query);
    const target = ms[0];
    if (target === undefined) return;
    const lvl = levelOf(items, target);
    if (lvl !== focusId) setFocusId(lvl);
    setHighlightId(target);
    setFocusNonce((n) => n + 1); // re-centre even if the same node is searched twice
  }, [items, query, focusId]);

  const toggleStatus = useCallback((s: WorkItemCanvasStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  function renderNode(node: CanvasNode) {
    const item = itemById.get(node.id);
    if (!item) return null;
    const dimmed = filterActive && !statusFilter.has(item.status);
    return (
      <WorkItemNode
        item={item}
        drillable={drillableById.get(node.id) ?? hasChildren(items, node.id)}
        highlighted={highlightId === node.id || matchIds.has(node.id)}
        dimmed={dimmed}
      />
    );
  }

  // The statuses present at this level — the filter only offers what's here.
  const presentStatuses = useMemo(() => {
    const order: WorkItemCanvasStatus[] = [
      'todo',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'cancelled',
    ];
    const present = new Set(level.nodes.map((n) => n.item.status));
    return order.filter((s) => present.has(s));
  }, [level]);

  return (
    <div className="flex h-full w-full flex-col bg-(--el-surface-soft)">
      {/* ── toolbar: breadcrumb + Back · search-to-focus · filters ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-(--el-border) bg-(--el-surface) px-3 py-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1">
          {focusId !== null && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
          )}
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            <li className="shrink-0">
              <Crumb label={ROOT_LABEL} active={focusId === null} onClick={() => drillTo(null)} />
            </li>
            {crumbs.map((c, i) => (
              <li key={c.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight
                  className="size-3.5 shrink-0 text-(--el-text-faint)"
                  aria-hidden="true"
                />
                <Crumb
                  label={c.identifier}
                  title={c.title}
                  active={i === crumbs.length - 1}
                  onClick={() => drillTo(c.id)}
                />
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              locate();
            }}
            className="w-56"
          >
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search work items"
              placeholder="Search work items"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              addonStart={<Search className="size-4 text-(--el-text-muted)" aria-hidden="true" />}
              addonEnd={
                <kbd className="rounded-(--radius-kbd) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-xs text-(--el-text-muted)">
                  /
                </kbd>
              }
            />
          </form>
          {presentStatuses.length > 0 && (
            <button
              type="button"
              aria-pressed={showFilters}
              onClick={() => setShowFilters((v) => !v)}
              className={`inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
                showFilters || filterActive
                  ? 'bg-(--el-surface-soft) text-(--el-text)'
                  : 'text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
              }`}
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              Filter
              {filterActive && (
                <span className="rounded-(--radius-badge) bg-(--el-accent) px-1.5 text-xs font-medium text-(--el-accent-text)">
                  {statusFilter.size}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {showFilters && presentStatuses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-(--el-border) bg-(--el-surface) px-3 py-2">
          <span className="mr-1 text-xs font-medium text-(--el-text-muted)">Status</span>
          {presentStatuses.map((s) => {
            const on = statusFilter.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={`rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
                  on
                    ? 'bg-(--el-accent) text-(--el-accent-text)'
                    : 'bg-(--el-muted) text-(--el-text-secondary) hover:text-(--el-text)'
                }`}
              >
                {STATUS_LABELS[s]}
              </button>
            );
          })}
          {filterActive && (
            <button
              type="button"
              onClick={() => setStatusFilter(new Set())}
              className="ml-1 text-xs text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* ── the canvas surface (one drill level at a time) ── */}
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div
            aria-busy="true"
            className="flex h-full w-full items-center justify-center bg-(--el-surface-soft)"
          >
            <Spinner aria-label="Loading roadmap" />
          </div>
        ) : error ? (
          <div className="flex h-full w-full items-center justify-center p-6">
            <div className="max-w-[24rem] rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding) text-center shadow-(--shadow-subtle)">
              <p className="text-sm font-semibold text-(--el-text)">Couldn’t load the roadmap</p>
              <p className="mt-1 text-sm text-(--el-text-muted)">{error}</p>
            </div>
          </div>
        ) : level.nodes.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center p-6">
            <div className="max-w-[24rem] text-center">
              <p className="text-sm font-semibold text-(--el-text)">
                {focusId === null ? 'Nothing planned yet' : 'No items at this level'}
              </p>
              <p className="mt-1 text-sm text-(--el-text-muted)">
                {focusId === null
                  ? 'Work items will appear here as the plan takes shape.'
                  : 'This node has no children to show.'}
              </p>
            </div>
          </div>
        ) : (
          <PlanningCanvas
            // Remount per drill level so the new level auto-fits to its own overview.
            key={`level:${focusId ?? 'root'}`}
            nodes={canvasNodes}
            edges={canvasEdges}
            renderNode={renderNode}
            onNodeMove={handleMove}
            onNodeActivate={handleActivate}
            focusNodeId={highlightId ?? undefined}
            focusNonce={focusNonce}
            ariaLabel={ariaLabel}
          />
        )}
      </div>
    </div>
  );
}

function Crumb({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={`max-w-[10rem] truncate rounded-(--radius-control) px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        active
          ? 'font-semibold text-(--el-text)'
          : 'text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
      }`}
    >
      {label}
    </button>
  );
}
