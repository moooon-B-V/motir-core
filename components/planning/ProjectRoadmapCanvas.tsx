'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, RotateCcw, Search } from 'lucide-react';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import {
  NODE_H,
  NODE_W,
  deterministicLayout,
  searchMatches,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';

// The reusable PROJECT-ROADMAP CANVAS (Subtask 7.20.2 / MOTIR-1194) — the
// FOUNDATION every planning surface composes. It shows the project roadmap ONE
// LEVEL AT A TIME (drill-down): the roots, then a node's children on drill. It
// owns the drill / breadcrumb / search / zoom UX over the shipped `PlanningCanvas`
// engine (MOTIR-1236) and pulls each level through a consumer-supplied
// `loadLevel(parentId)` — so the FETCH lives in the consumer (the canvas stays
// presentational) and the whole forest is never loaded up front (the per-level
// read, MOTIR-1010; mistake #91).
//
// CONTENT-AGNOSTIC: each node arrives with its own pre-rendered `content` (a
// `StationCard`, a `WorkItemNode`, an `IdeaCard`) + a `drillable` flag — so the
// onboarding canvas (stations + roots) and the roadmap (work items) are the SAME
// component. Drilling a node fetches its children; one level fills the screen, so
// a chain stays legible at any tree size.

export interface RoadmapLevel {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
}

export interface ProjectRoadmapCanvasProps {
  /** Fetch one level's nodes + edges (roots when `parentId` is null; else the
   *  parent's children). The consumer owns the I/O; memoize it. */
  loadLevel: (parentId: string | null) => Promise<RoadmapLevel>;
  /** Bump to refetch the CURRENT level when the consumer's source data changes
   *  (e.g. onboarding stations update as tiers complete). */
  reloadKey?: string | number;
  /** Saved per-node world positions (consumer-owned persistence). */
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** Drop the saved positions for these nodes (a layout RESET) — the consumer
   *  clears them from its store so the nodes fall back to the auto-layout. Fired by
   *  the "Reset layout" button and automatically when a level's auto-laid node set
   *  CHANGES (a re-plan), so stale positions never linger. */
  onResetPositions?: (nodeIds: string[]) => void;
  /** A LEAF node (not drillable) was activated. */
  onSelect?: (id: string) => void;
  /** Open the quick-view DETAIL surface for a node (MOTIR-1352). When wired, the
   *  canvas renders a **View** button on the SELECTED card (beside the "Open" drill
   *  pill) for every node flagged `viewable` — the work-item consumer opens the
   *  quick-view peek, the onboarding consumer opens the tier doc. View (open detail)
   *  is DISTINCT from select (highlight) and from "Open" (drill into children). */
  onView?: (id: string) => void;
  /** Show the search-to-locate overlay (`/` shortcut) — locates within the level. */
  searchable?: boolean;
  /** The breadcrumb root label. */
  rootLabel?: string;
  ariaLabel?: string;
}

interface Crumb {
  id: string;
  label: string;
}

export function ProjectRoadmapCanvas({
  loadLevel,
  reloadKey,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  onView,
  searchable = false,
  rootLabel = 'Roadmap',
  ariaLabel = 'Project roadmap',
}: ProjectRoadmapCanvasProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [level, setLevel] = useState<RoadmapLevel | null>(null);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(
    {},
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const reqSeq = useRef(0);
  // Hold the latest loadLevel so the load effect refetches on focus / reloadKey —
  // NOT on the fetcher's identity (a consumer's loadLevel may be recreated each
  // render; `reloadKey` is the explicit "the data changed" signal).
  const loadLevelRef = useRef(loadLevel);
  useEffect(() => {
    loadLevelRef.current = loadLevel;
  }, [loadLevel]);

  // `/` focuses the search field (unless already typing into one).
  useEffect(() => {
    if (!searchable) return;
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
  }, [searchable]);

  // Fetch the current level. The PRIOR level stays visible during a refetch (no
  // flicker); a stale response (an out-of-order resolve) is discarded by sequence.
  useEffect(() => {
    const seq = ++reqSeq.current;
    let alive = true;
    void (async () => {
      try {
        const lvl = await loadLevelRef.current(focusId);
        if (alive && seq === reqSeq.current) setLevel(lvl);
      } catch {
        if (alive && seq === reqSeq.current) setLevel({ nodes: [], deps: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [focusId, reloadKey]);

  const nodes = useMemo(() => level?.nodes ?? [], [level]);
  const deps = useMemo(() => level?.deps ?? [], [level]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const matchIds = useMemo(() => new Set(searchMatches(nodes, query)), [nodes, query]);
  // The selected node + everything it is connected to (its dependencies/blockers) —
  // these stay lit while the rest of the level dims, so the selection reads clearly.
  const connectedIds = useMemo(() => {
    if (selectedId === null) return null;
    const s = new Set<string>([selectedId]);
    for (const d of deps) {
      if (d.from === selectedId) s.add(d.to);
      if (d.to === selectedId) s.add(d.from);
    }
    return s;
  }, [selectedId, deps]);
  const layout = useMemo(
    () =>
      deterministicLayout(
        nodes.map((n) => n.id),
        deps.map((d) => ({ from: d.from, to: d.to })),
      ),
    [nodes, deps],
  );

  const positionOf = useCallback(
    (n: ProjectCanvasNode) => {
      const saved = localPositions[n.id] ?? positions?.[n.id];
      if (saved) return saved;
      if (n.x !== undefined && n.y !== undefined) return { x: n.x, y: n.y };
      return layout[n.id] ?? { x: 0, y: 0 };
    },
    [localPositions, positions, layout],
  );

  // The AUTO-LAID nodes (work items) — the ones the AUTO-RESET tracks (fixed-position
  // nodes — stations / the plan preview carry an explicit x/y — are excluded: a
  // re-plan never invalidates their arrangement).
  const autoLaidIds = useMemo(
    () => nodes.filter((n) => n.x === undefined || n.y === undefined).map((n) => n.id),
    [nodes],
  );
  // The ARRANGED nodes — anything the user has hand-moved on THIS level (a saved or
  // local override), whether a work item or a station. The "Reset layout" button
  // acts on these, so it works on the root "Your project" canvas (stations) too.
  const arrangedIds = useMemo(
    () => nodes.map((n) => n.id).filter((id) => localPositions[id] ?? positions?.[id]),
    [nodes, localPositions, positions],
  );
  const hasArrangement = arrangedIds.length > 0;

  // Reset this level's hand-moved nodes to their default layout (local + persisted).
  const resetLayout = useCallback(() => {
    if (arrangedIds.length === 0) return;
    setLocalPositions((prev) => {
      const next = { ...prev };
      for (const id of arrangedIds) delete next[id];
      return next;
    });
    onResetPositions?.(arrangedIds);
  }, [arrangedIds, onResetPositions]);

  // AUTO-RESET on a layer change: if a level's auto-laid node SET differs from the
  // last time we rendered that level (a re-plan added/removed/reordered items), its
  // saved positions are stale → drop them so the layout recomputes cleanly. Keyed
  // by focus so each drill level tracks its own signature.
  const layoutSigRef = useRef<Map<string, string>>(new Map());
  const resetRef = useRef(onResetPositions);
  useEffect(() => {
    resetRef.current = onResetPositions;
  }, [onResetPositions]);
  useEffect(() => {
    // Don't track until the level has auto-laid nodes — otherwise the empty
    // pre-load render would register a signature and make the first load look
    // like a change.
    if (autoLaidIds.length === 0) return;
    const sig = [...autoLaidIds].sort().join('|');
    const key = focusId ?? '__root__';
    const prev = layoutSigRef.current.get(key);
    layoutSigRef.current.set(key, sig);
    if (prev !== undefined && prev !== sig) {
      resetRef.current?.(autoLaidIds);
      setLocalPositions((p) => {
        const next = { ...p };
        for (const id of autoLaidIds) delete next[id];
        return next;
      });
    }
  }, [autoLaidIds, focusId]);

  const canvasNodes: CanvasNode[] = nodes.map((n) => ({
    id: n.id,
    ...positionOf(n),
    width: n.width ?? NODE_W,
    height: n.height ?? NODE_H,
  }));
  const canvasEdges: CanvasEdge[] = deps.map((d) => ({
    from: d.from,
    to: d.to,
    variant: d.variant,
  }));

  const handleMove = useCallback(
    (id: string, x: number, y: number) => {
      setLocalPositions((prev) => ({ ...prev, [id]: { x, y } }));
      onNodeMove?.(id, x, y);
    },
    [onNodeMove],
  );

  // Clicking a card SELECTS it (focus + highlight its connections) — it does NOT
  // drill. Drilling is the explicit "Open" affordance on the selected card. The
  // consumer's onSelect still fires (e.g. an onboarding station opens its doc).
  const handleActivate = useCallback(
    (id: string) => {
      setSelectedId(id);
      onSelect?.(id);
    },
    [onSelect],
  );

  const handleDrill = useCallback(
    (id: string) => {
      const n = byId.get(id);
      if (!n?.drillable) return;
      // Drill: fetch the node's children (the load effect fires on focusId change).
      setCrumbs((c) => [...c, { id, label: n.crumbLabel ?? n.searchText }]);
      setLocalPositions({});
      setSelectedId(null);
      setFocusId(id);
      setHighlightId(null);
    },
    [byId],
  );

  const navigate = useCallback((crumbId: string | null) => {
    setLocalPositions({});
    setHighlightId(null);
    setSelectedId(null);
    if (crumbId === null) {
      setCrumbs([]);
      setFocusId(null);
      return;
    }
    setCrumbs((c) => {
      const i = c.findIndex((x) => x.id === crumbId);
      return i >= 0 ? c.slice(0, i + 1) : c;
    });
    setFocusId(crumbId);
  }, []);

  const goBack = useCallback(() => {
    navigate(crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.id ?? null) : null);
  }, [crumbs, navigate]);

  const locate = useCallback(() => {
    const ms = searchMatches(nodes, query);
    const target = ms[0];
    if (target === undefined) return;
    setHighlightId(target);
    setFocusNonce((n) => n + 1);
  }, [nodes, query]);

  function renderNode(cn: CanvasNode) {
    const node = byId.get(cn.id);
    if (!node) return null;
    const matched = highlightId === cn.id || matchIds.has(cn.id);
    const selected = cn.id === selectedId;
    const dimmed = connectedIds !== null && !connectedIds.has(cn.id);
    return (
      <div
        data-highlighted={matched || undefined}
        data-selected={selected || undefined}
        className={[
          'relative rounded-(--radius-card) transition-opacity',
          selected || matched
            ? 'ring-2 ring-(--el-accent) ring-offset-2 ring-offset-(--el-surface-soft)'
            : '',
          dimmed ? 'opacity-35' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {node.content}
        {/* The selected card's ACTION SLOT — surfaced on the bottom edge so the
            detail / drill actions are obvious without hijacking a plain click
            (which now just selects). VIEW (open the quick-view detail, MOTIR-1352)
            and OPEN (drill into children) are DISTINCT and sit side by side; a leaf
            shows View alone. Each stops the press from starting a canvas drag. */}
        {selected && ((onView && node.viewable) || node.drillable) && (
          <div className="absolute -bottom-3.5 left-1/2 flex -translate-x-1/2 items-center gap-2">
            {onView && node.viewable && (
              <button
                type="button"
                data-testid="view-button"
                aria-label={`View ${node.crumbLabel ?? node.searchText}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onView(cn.id);
                }}
                className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold whitespace-nowrap text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Eye className="size-3.5" aria-hidden="true" />
                View
              </button>
            )}
            {node.drillable && (
              <button
                type="button"
                data-testid="drill-button"
                aria-label="Open this item's children"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDrill(cn.id);
                }}
                className="inline-flex items-center gap-1 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold whitespace-nowrap text-(--el-accent-text) shadow-(--shadow-card) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                Open
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const drilled = crumbs.length > 0;

  return (
    <div className="relative h-full w-full">
      {/* breadcrumb + Back overlay — only while drilled */}
      {drilled && (
        <nav
          aria-label="Breadcrumb"
          className="absolute top-3 left-3 z-10 flex max-w-[min(36rem,calc(100%-1.5rem))] items-center gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-2 py-1 shadow-(--shadow-card)"
        >
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            <li className="shrink-0">
              <Crumb label={rootLabel} active={false} onClick={() => navigate(null)} />
            </li>
            {crumbs.map((c, i) => (
              <li key={c.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight
                  className="size-3.5 shrink-0 text-(--el-text-faint)"
                  aria-hidden="true"
                />
                <Crumb
                  label={c.label}
                  active={i === crumbs.length - 1}
                  onClick={() => navigate(c.id)}
                />
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* search-to-locate overlay (within the current level) */}
      {searchable && (
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            locate();
          }}
          className="absolute top-3 right-3 z-10 w-60"
        >
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search the roadmap"
            placeholder="Search the roadmap"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            addonStart={<Search className="size-4 text-(--el-text-muted)" aria-hidden="true" />}
          />
        </form>
      )}

      {/* RESET LAYOUT — only when the user has hand-arranged an auto-laid node on
          this level; clears those positions back to the dependency layout. Sits at
          the bottom-right, clear of the engine's bottom-left zoom controls. */}
      {hasArrangement && onResetPositions && (
        <button
          type="button"
          onClick={resetLayout}
          className="absolute right-3 bottom-4 z-10 inline-flex items-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset layout
        </button>
      )}

      {/* edge LEGEND — shown when the level has real blocked-by DEPENDENCY edges,
          so the canvas is self-documenting (MOTIR-1331). Sequence/`flow` edges (the
          onboarding station serpentine) are excluded — they are drawn, but they are
          not dependencies. Sits above the engine's bottom-left zoom. */}
      {deps.some((d) => d.kind !== 'flow') && (
        <div
          data-testid="edge-legend"
          className="absolute bottom-[4.25rem] left-3 z-10 flex flex-col gap-1.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-3 py-2 shadow-(--shadow-card)"
        >
          <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-faint) uppercase">
            Dependencies
          </span>
          {(
            [
              ['committed', 'blocks', 'blocker done'],
              ['pending', 'pending', 'not done yet'],
              ['warning', 'cross-story', 'in another story'],
            ] as const
          ).map(([kind, label, meaning]) => (
            <span key={kind} className="flex items-center gap-2 text-xs text-(--el-text-strong)">
              <svg viewBox="0 0 40 12" className="h-3 w-10 shrink-0" aria-hidden="true">
                <path
                  d="M2 6H31"
                  fill="none"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeDasharray={kind === 'pending' ? '2 5' : undefined}
                  className={
                    kind === 'warning'
                      ? 'stroke-(--el-warning)'
                      : kind === 'pending'
                        ? 'stroke-(--el-canvas-edge-pending)'
                        : 'stroke-(--el-canvas-edge-committed)'
                  }
                />
                <path
                  d="M30 2 36 6 30 10z"
                  className={
                    kind === 'warning'
                      ? 'fill-(--el-warning)'
                      : kind === 'pending'
                        ? 'fill-(--el-canvas-edge-pending)'
                        : 'fill-(--el-canvas-edge-committed)'
                  }
                />
              </svg>
              {label}
              <span className="text-(--el-text-muted)">· {meaning}</span>
            </span>
          ))}
        </div>
      )}

      {level === null ? (
        <div
          aria-busy="true"
          className="flex h-full w-full items-center justify-center bg-(--el-canvas)"
        >
          <Spinner aria-label="Loading the roadmap" />
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
          <div className="max-w-[24rem] text-center">
            <p className="text-sm font-semibold text-(--el-text)">
              {drilled ? 'No items at this level' : 'Nothing on the roadmap yet'}
            </p>
            <p className="mt-1 text-sm text-(--el-text-muted)">
              {drilled
                ? 'This node has no children to show.'
                : 'Work items will appear here as the plan takes shape.'}
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
          onNodeMove={onNodeMove ? handleMove : undefined}
          onNodeActivate={handleActivate}
          selectedId={selectedId}
          onBackgroundClick={() => setSelectedId(null)}
          focusNodeId={highlightId ?? undefined}
          focusNonce={focusNonce}
          ariaLabel={ariaLabel}
        />
      )}
    </div>
  );
}

function Crumb({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={`max-w-[12rem] truncate rounded-(--radius-control) px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        active
          ? 'font-semibold text-(--el-text)'
          : 'text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
      }`}
    >
      {label}
    </button>
  );
}
