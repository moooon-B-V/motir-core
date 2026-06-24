'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
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
  /** A LEAF node (not drillable) was activated. */
  onSelect?: (id: string) => void;
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
  onSelect,
  searchable = false,
  rootLabel = 'Roadmap',
  ariaLabel = 'Project roadmap',
}: ProjectRoadmapCanvasProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [level, setLevel] = useState<RoadmapLevel | null>(null);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
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

  const canvasNodes: CanvasNode[] = nodes.map((n) => ({
    id: n.id,
    ...positionOf(n),
    width: NODE_W,
    height: NODE_H,
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

  const handleActivate = useCallback(
    (id: string) => {
      const n = byId.get(id);
      if (n?.drillable) {
        // Drill: fetch the node's children (the load effect fires on focusId change).
        setCrumbs((c) => [...c, { id, label: n.crumbLabel ?? n.searchText }]);
        setLocalPositions({});
        setFocusId(id);
        setHighlightId(null);
      } else {
        onSelect?.(id);
      }
    },
    [byId, onSelect],
  );

  const navigate = useCallback((crumbId: string | null) => {
    setLocalPositions({});
    setHighlightId(null);
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
    return (
      <div
        data-highlighted={matched || undefined}
        className={
          matched
            ? 'rounded-(--radius-card) ring-2 ring-(--el-accent) ring-offset-2 ring-offset-(--el-surface-soft)'
            : undefined
        }
      >
        {node.content}
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
            addonEnd={
              <kbd className="rounded-(--radius-kbd) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-xs text-(--el-text-muted)">
                /
              </kbd>
            }
          />
        </form>
      )}

      {level === null ? (
        <div
          aria-busy="true"
          className="flex h-full w-full items-center justify-center bg-(--el-surface-soft)"
        >
          <Spinner aria-label="Loading the roadmap" />
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center bg-(--el-surface-soft) p-6">
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
