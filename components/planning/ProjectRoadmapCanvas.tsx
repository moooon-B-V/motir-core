'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';
import { Input } from '@/components/ui/Input';
import {
  NODE_H,
  NODE_W,
  breadcrumb,
  computeLevel,
  deterministicLayout,
  hasChildren,
  levelOf,
  searchMatches,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';

// The reusable PROJECT-ROADMAP CANVAS (Subtask 7.20.2 / MOTIR-1194) — the
// FOUNDATION every planning surface composes. It renders the WHOLE project as one
// roadmap: the pre-plan tier / design / plan stations AND the produced epic →
// story → subtask work-item tree are all nodes on the same surface (the 4 tier
// docs ARE part of the roadmap). Built ONCE over the shipped `PlanningCanvas`
// engine (MOTIR-1236): this adds the deterministic auto-layout + drill-down +
// search-to-focus + within/cross edge classification; the engine owns pan / zoom /
// drag / fit and the read-only edges.
//
// CONTENT-AGNOSTIC: each node arrives with its own pre-rendered `content` (a
// `StationCard`, a `WorkItemNode`, an `IdeaCard`) — so the onboarding canvas
// (stations) and the roadmap (work items) are the SAME component, not two. It owns
// no fetching; the forest + edges + saved positions are the consumer's. Drilling a
// node re-feeds the engine that node's children laid out as their own chain — one
// level fills the screen, so a chain stays legible at any tree size.

export interface ProjectRoadmapCanvasProps {
  nodes: ProjectCanvasNode[];
  deps?: ProjectCanvasDep[];
  /** Saved per-node world positions (consumer-owned persistence); overrides a
   *  node's explicit `x`/`y` and the deterministic auto-layout. */
  positions?: Record<string, { x: number; y: number }>;
  /** A node was dragged — forward to persistence (the 7.3.77 save seam). */
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** A LEAF node (no children) was activated (a drillable node drills instead). */
  onSelect?: (id: string) => void;
  /** Show the search-to-locate-and-focus overlay (`/` shortcut). Off by default so
   *  a bare canvas (e.g. onboarding's pre-plan stations) stays chrome-free. */
  searchable?: boolean;
  /** Start drilled at this node (e.g. a deep link). */
  initialFocusId?: string | null;
  ariaLabel?: string;
}

export function ProjectRoadmapCanvas({
  nodes,
  deps = [],
  positions,
  onNodeMove,
  onSelect,
  searchable = false,
  initialFocusId = null,
  ariaLabel = 'Project roadmap',
}: ProjectRoadmapCanvasProps) {
  const [focusId, setFocusId] = useState<string | null>(initialFocusId);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(
    {},
  );
  const searchRef = useRef<HTMLInputElement>(null);

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

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const level = useMemo(() => computeLevel(nodes, deps, focusId), [nodes, deps, focusId]);
  const crumbs = useMemo(() => breadcrumb(nodes, focusId), [nodes, focusId]);
  const matchIds = useMemo(() => new Set(searchMatches(nodes, query)), [nodes, query]);

  // The deterministic fallback layout for THIS level (used only where a node has
  // no explicit / saved position).
  const layout = useMemo(
    () =>
      deterministicLayout(
        level.nodes.map((n) => n.node.id),
        level.edges,
      ),
    [level],
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

  const canvasNodes: CanvasNode[] = level.nodes.map(({ node }) => ({
    id: node.id,
    ...positionOf(node),
    width: NODE_W,
    height: NODE_H,
  }));
  const canvasEdges: CanvasEdge[] = level.edges.map((e) => ({
    from: e.from,
    to: e.to,
    variant: e.variant,
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
      // A node with children DRILLS in; a leaf is SELECTED (the drill-down model).
      if (hasChildren(nodes, id)) {
        setFocusId(id);
        setHighlightId(null);
      } else {
        onSelect?.(id);
      }
    },
    [nodes, onSelect],
  );

  const drillTo = useCallback((id: string | null) => {
    setFocusId(id);
    setHighlightId(null);
  }, []);

  const goBack = useCallback(() => {
    const parent = crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.id ?? null) : null;
    drillTo(parent);
  }, [crumbs, drillTo]);

  const locate = useCallback(() => {
    const ms = searchMatches(nodes, query);
    const target = ms[0];
    if (target === undefined) return;
    const lvl = levelOf(nodes, target);
    if (lvl !== focusId) setFocusId(lvl);
    setHighlightId(target);
    setFocusNonce((n) => n + 1); // re-centre even when the same node is searched twice
  }, [nodes, query, focusId]);

  function renderNode(cn: CanvasNode) {
    const node = byId.get(cn.id);
    if (!node) return null;
    const matched = highlightId === cn.id || matchIds.has(cn.id);
    // The match RING is applied by the foundation as a wrapper, so node content
    // stays decoupled (the consumer pre-renders it without knowing search state).
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

  return (
    <div className="relative h-full w-full">
      {/* breadcrumb + Back overlay — only while drilled (bare at the top level) */}
      {focusId !== null && (
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
              <Crumb label="Roadmap" active={false} onClick={() => drillTo(null)} />
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
                  onClick={() => drillTo(c.id)}
                />
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* search-to-focus overlay */}
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

      {level.nodes.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center bg-(--el-surface-soft) p-6">
          <div className="max-w-[24rem] text-center">
            <p className="text-sm font-semibold text-(--el-text)">
              {focusId === null ? 'Nothing on the roadmap yet' : 'No items at this level'}
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
