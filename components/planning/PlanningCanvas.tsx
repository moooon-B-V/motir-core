'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { Flag, Maximize2, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type Rect,
  type View,
  arrivalView,
  centerOn,
  fitView,
  nodesBounds,
  routeEdges,
  screenDeltaToWorld,
  zoomToward,
} from '@/lib/planning/canvasGeometry';

// The reusable spatial planning CANVAS (Subtask 7.3.76 / MOTIR-1236) — a Miro-style
// pan / zoom / drag / fit viewport that renders caller-supplied nodes + READ-ONLY
// dependency edges (design `design/ai-chat/canvas-spatial.*`). It is a FOUNDATION:
// the onboarding hub (840), generation review (7.4) and the persistent roadmap
// (7.19) compose it. It owns only the SURFACE + the interaction; the consumer owns
// the node content (`renderNode`), the node positions (CONTROLLED via `onNodeMove`
// — auto-layout + persistence live in the consumer / 7.3.77), and the edge list.
//
// "Render the reality": this component draws exactly the nodes + edges it is given
// (the real work-item graph) — it never invents structure and never lets the user
// create / edit / delete a link. The interaction MATH is in `lib/planning/
// canvasGeometry` (unit-tested); here is the pointer / wheel / keyboard I/O + the
// measured node rects that anchor the edges. Tokens only (`--el-*` + shape).

export interface CanvasNode {
  id: string;
  /** WORLD position (the consumer owns it; auto-layout + persistence are external). */
  x: number;
  y: number;
  /** Optional hint used for edge anchoring until the node is measured. */
  width?: number;
  height?: number;
}

export interface CanvasEdge {
  from: string;
  to: string;
  /**
   * `firm` = a hard dependency (solid); `pending` = a not-yet-done edge (dashed);
   * `cross` = a dependency crossing a story/parent boundary — the bad-plan SIGNAL
   * the dependency-arrow audit forbids (warning-toned + a flag badge at the
   * midpoint, so a reviewer SEES the tangle). A correct plan is a TREE; a `cross`
   * edge means the plan is wrong (design `design/roadmap/*`, MOTIR-1009/1194).
   *
   * `running` = the dependency a RUN is currently travelling along: an edge FROM
   * a work item an agent is working TO one it blocks. It flows, because on a run
   * the edge is what says *what becomes reachable when this lands* — the question
   * a static arrow cannot answer (MOTIR-3972; `design/runs/design-notes.md`
   * § THE RUNNING EDGE).
   *
   * ⚠️ NAMED FOR THE STATE, NOT THE EFFECT, so a later surface with the same
   * meaning reuses it instead of adding a second animated variant. And it is
   * OPT-IN like every other capability here (`searchable`, `locatable`,
   * `fullScreenable`): a consumer that never sends it renders exactly as before,
   * which is what keeps the onboarding canvas from growing a flowing edge.
   */
  variant?: 'firm' | 'pending' | 'cross' | 'running';
}

export interface PlanningCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Render a node's CONTENT; the canvas owns its box, position + drag. */
  renderNode: (node: CanvasNode) => ReactNode;
  /** A node was dragged to (x, y) in world coords. Omit → nodes are not draggable. */
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** A node was clicked/tapped (a press that did NOT become a drag). */
  onNodeActivate?: (id: string) => void;
  /**
   * Search-to-focus: the node to PAN to the centre of the viewport. Centring fires
   * whenever `focusNonce` changes (so re-searching the SAME node re-centres it);
   * the scale is left untouched. Omit either and no centring happens.
   */
  focusNodeId?: string;
  focusNonce?: number;
  /**
   * Target ZOOM for the focus pan. When set, centring ALSO resets the scale to this
   * value (a zoom-to-fit-the-card, so a node found while zoomed far out/in lands at a
   * readable default size — the LOCATE control, MOTIR-1421). Omit → the scale is
   * preserved (the search-locate's pan-only behaviour).
   */
  focusScale?: number;
  /** The selected node — its edges (and their other ends) stay lit while every
   *  other connector dims, so the selection's dependencies/blockers stand out. */
  selectedId?: string | null;
  /** A press on empty canvas that did not pan — used to clear the selection. */
  onBackgroundClick?: () => void;
  ariaLabel?: string;
  /**
   * The ARRIVAL configuration (MOTIR-3837) — the once-only fit, with a legibility
   * FLOOR and a focal node to centre on when the level cannot be shown whole.
   *
   * ABSENT (the default) is byte-for-byte today's `fitView`, which is what the
   * three canvas consumers that do not ask for this keep. It changes the ARRIVAL
   * only: the explicit fit-to-view control still frames the WHOLE level down to
   * `MIN_SCALE`, and `focalNodeId` naming nothing simply centres the bounds.
   */
  arrival?: { floor: number; focalNodeId?: string | null };
  className?: string;
}

const FALLBACK = { w: 300, h: 120 }; // edge anchoring before a node is measured
const ACTIVATE_SLOP = 4; // px of movement that turns a click into a drag
const ZOOM_STEP = 1.2; // the −/+ buttons (one decisive step)
// Per wheel/trackpad EVENT — kept gentle so a trackpad (which fires many events)
// doesn't zoom in jumps; the buttons stay the fast path.
const WHEEL_STEP = 1.04;
const PAN_KEY_STEP = 64;

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean }
  | {
      kind: 'node';
      id: string;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      scale: number;
      moved: boolean;
    };

export function PlanningCanvas({
  nodes,
  edges,
  renderNode,
  onNodeMove,
  onNodeActivate,
  focusNodeId,
  focusNonce,
  focusScale,
  selectedId,
  onBackgroundClick,
  ariaLabel,
  arrival,
  className,
}: PlanningCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});

  const vpRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<Map<string, HTMLElement>>(new Map());
  const gesture = useRef<Gesture | null>(null);
  const didFit = useRef(false);
  // Unique marker ids (a doc-global `<marker>` id collides across canvas instances).
  const mId = useId().replace(/:/g, '');

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rectOf = (n: CanvasNode): Rect => {
    const p = dragPos[n.id];
    const s = sizes[n.id];
    return {
      x: p ? p.x : n.x,
      y: p ? p.y : n.y,
      w: s?.w ?? n.width ?? FALLBACK.w,
      h: s?.h ?? n.height ?? FALLBACK.h,
    };
  };
  // The explicit fit-to-view control's view: the WHOLE level, framed, down to
  // `MIN_SCALE`. Unchanged by MOTIR-3837 — that is what the control is for.
  const computeFit = (vw: number, vh: number): View =>
    fitView(nodesBounds(nodes.map(rectOf)), { w: vw, h: vh });
  // The ARRIVAL view: the same fit unless the consumer asked for a legibility floor
  // (MOTIR-3837), in which case a level that cannot be shown legibly arrives AT the
  // floor, centred per axis on the focal card rather than shrunk to frame.
  const computeArrival = (vw: number, vh: number): View => {
    if (!arrival) return computeFit(vw, vh);
    const focal = arrival.focalNodeId ? nodeById.get(arrival.focalNodeId) : undefined;
    return arrivalView(
      nodesBounds(nodes.map(rectOf)),
      { w: vw, h: vh },
      arrival.floor,
      focal ? rectOf(focal) : undefined,
    );
  };

  // Route ALL edges together so the global lane pass keeps every connector on its
  // own track (one entry per edge, aligned to `edges`; null where a node is gone).
  const routes = routeEdges(edges, (id) => {
    const n = nodeById.get(id);
    return n ? rectOf(n) : undefined;
  });

  // ── measure node sizes so edges anchor accurately (RO callback setState) ──
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setSizes((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.nodeId;
          if (!id) continue;
          const { width: w, height: h } = e.contentRect;
          if (!prev[id] || prev[id].w !== w || prev[id].h !== h) {
            next[id] = { w, h };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    nodeEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [nodes]);

  // ── fit-to-view ONCE, when the viewport first has a size (RO callback) ──
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (didFit.current || nodes.length === 0) return;
      const r = vp.getBoundingClientRect();
      if (r.width === 0) return;
      didFit.current = true;
      setView(computeArrival(r.width, r.height));
    });
    ro.observe(vp);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  // ── search-to-focus: pan the requested node to the viewport centre ──
  // Keyed on `focusNonce` so a repeat focus of the same node re-centres it. The scale
  // is preserved (a pan) UNLESS `focusScale` is set, in which case the node is also
  // zoomed to that readable default (the locate control, MOTIR-1421). Reads the live
  // node/rect each fire.
  useEffect(() => {
    if (focusNonce === undefined || !focusNodeId) return;
    const vp = vpRef.current;
    const n = nodeById.get(focusNodeId);
    if (!vp || !n) return;
    const r = vp.getBoundingClientRect();
    if (r.width === 0) return;
    setView((v) => centerOn(rectOf(n), { w: r.width, h: r.height }, focusScale ?? v.scale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, focusNodeId]);

  // ── wheel zoom via a NON-passive native listener (so preventDefault holds) ──
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      setView((v) => zoomToward(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  // ── pointer: drag a node (if movable) or pan the surface ──
  function onPointerDown(e: RPointerEvent<HTMLDivElement>) {
    const vp = vpRef.current;
    if (!vp) return;
    const nodeEl = (e.target as HTMLElement).closest('[data-node-id]') as HTMLElement | null;
    const id = nodeEl?.dataset.nodeId;
    const n = id ? nodeById.get(id) : undefined;
    vp.setPointerCapture(e.pointerId);
    // A press on a node starts a node gesture when it can drag OR activate; the
    // pointerup decides which (a press that didn't move is a click → activate).
    if (n && (onNodeMove || onNodeActivate)) {
      gesture.current = {
        kind: 'node',
        id: n.id,
        sx: e.clientX,
        sy: e.clientY,
        ox: n.x,
        oy: n.y,
        scale: view.scale,
        moved: false,
      };
    } else {
      gesture.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        tx: view.tx,
        ty: view.ty,
        moved: false,
      };
    }
  }
  function onPointerMove(e: RPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      if (
        Math.abs(e.clientX - g.sx) > ACTIVATE_SLOP ||
        Math.abs(e.clientY - g.sy) > ACTIVATE_SLOP
      ) {
        g.moved = true;
      }
      setView((v) => ({ ...v, tx: g.tx + (e.clientX - g.sx), ty: g.ty + (e.clientY - g.sy) }));
    } else {
      if (
        Math.abs(e.clientX - g.sx) > ACTIVATE_SLOP ||
        Math.abs(e.clientY - g.sy) > ACTIVATE_SLOP
      ) {
        g.moved = true;
      }
      if (!onNodeMove) return; // activate-only node: don't move it
      const d = screenDeltaToWorld(e.clientX - g.sx, e.clientY - g.sy, g.scale);
      const nx = g.ox + d.dx;
      const ny = g.oy + d.dy;
      setDragPos((p) => ({ ...p, [g.id]: { x: nx, y: ny } }));
      onNodeMove(g.id, nx, ny);
    }
  }
  function endGesture(e: RPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    gesture.current = null;
    vpRef.current?.releasePointerCapture(e.pointerId);
    if (g?.kind === 'node') {
      setDragPos((p) => {
        const next = { ...p };
        delete next[g.id];
        return next;
      });
      // A press that never moved is a click → activate the node.
      if (!g.moved) onNodeActivate?.(g.id);
    } else if (g?.kind === 'pan' && !g.moved) {
      // A press on empty canvas that did not pan → clear the selection.
      onBackgroundClick?.();
    }
  }

  function zoomCentred(factor: number) {
    const r = vpRef.current?.getBoundingClientRect();
    if (!r) return;
    setView((v) => zoomToward(v, factor, r.width / 2, r.height / 2));
  }
  function doFit() {
    const r = vpRef.current?.getBoundingClientRect();
    if (!r) return;
    setView(computeFit(r.width, r.height));
  }
  function onKeyDown(e: RKeyboardEvent<HTMLDivElement>) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomCentred(ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomCentred(1 / ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      doFit();
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? PAN_KEY_STEP : e.key === 'ArrowRight' ? -PAN_KEY_STEP : 0;
      const dy = e.key === 'ArrowUp' ? PAN_KEY_STEP : e.key === 'ArrowDown' ? -PAN_KEY_STEP : 0;
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    }
  }

  const worldTransform = {
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
    transformOrigin: '0 0' as const,
  };

  return (
    <div
      className={['relative h-full w-full overflow-hidden', className].filter(Boolean).join(' ')}
    >
      <div
        ref={vpRef}
        role="application"
        aria-label={ariaLabel ?? 'Planning canvas'}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={onKeyDown}
        className="absolute inset-0 cursor-grab touch-none bg-(--el-canvas) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        data-testid="planning-canvas"
      >
        {/* Arrowhead markers — in their OWN <svg> (marker refs are doc-global), so
            the canvas-edges <path> count stays = the edge count. One per variant,
            coloured to match its edge → a reader can tell DIRECTION (the arrow
            points blocker → blocked). MOTIR-1331. */}
        <svg className="absolute h-0 w-0" aria-hidden="true">
          <defs>
            {(['committed', 'pending', 'warning', 'emphasis', 'running'] as const).map((kind) => (
              <marker
                key={kind}
                id={`${mId}-${kind}`}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M0 0L10 5L0 10z"
                  className={
                    kind === 'warning'
                      ? 'fill-(--el-warning)'
                      : kind === 'running'
                        ? 'fill-(--el-status-in-progress)'
                        : kind === 'emphasis'
                          ? // the ACCENT INK, not `--el-accent` (the FILL). A marker
                            // painted on the board is a mark ON a surface, so it owes
                            // 3:1 against `--el-canvas` — which the fill misses in four
                            // light palettes (1.24–2.77:1). MOTIR-4474.
                            'fill-(--el-accent-on-surface)'
                          : kind === 'pending'
                            ? 'fill-(--el-canvas-edge-pending)'
                            : 'fill-(--el-canvas-edge-committed)'
                  }
                />
              </marker>
            ))}
          </defs>
        </svg>

        {/* edges — read-only dependency connectors (non-scaling stroke) */}
        <svg
          className="pointer-events-none absolute top-0 left-0 h-full w-full"
          style={{ ...worldTransform, overflow: 'visible' }}
          aria-hidden="true"
          data-testid="canvas-edges"
        >
          {edges.map((edge, i) => {
            const route = routes[i];
            if (!route) return null;
            const pending = edge.variant === 'pending';
            const cross = edge.variant === 'cross';
            const running = edge.variant === 'running';
            // When a node is selected, only its own edges stay lit; a lit non-cross
            // edge is EMPHASISED in the accent INK (so even a faint dashed `pending`
            // connector clearly pops, matching the selected card's accent ring).
            // ⚠️ `--el-accent-on-surface`, NEVER `--el-accent`. The fill token's
            // contrast is guaranteed against `--el-accent-text` sitting ON it, not
            // against a board it is painted on: on Candy light it measured 1.26:1
            // on `--el-canvas` and 1.01:1 against a plain edge dimmed to 12%, so
            // selecting a card painted its own edges the shade of the ones it was
            // de-emphasising. `tests/theme/canvasEmphasisInkContrast.test.ts` reads
            // the token back out of this file and measures it. MOTIR-4474.
            const lit = selectedId == null || edge.from === selectedId || edge.to === selectedId;
            // ⚠️ `running` outranks the selection emphasis and yields only to
            // `cross`. A run's live edge must stay the live one while a reader
            // clicks around the graph; `cross` stays loudest because a plan that
            // is WRONG outranks a plan that is in motion.
            const emph = lit && selectedId != null && !cross && !running;
            const marker = cross
              ? 'warning'
              : running
                ? 'running'
                : emph
                  ? 'emphasis'
                  : pending
                    ? 'pending'
                    : 'committed';
            return (
              <path
                key={`${edge.from}~${edge.to}~${i}`}
                d={route.d}
                fill="none"
                className={
                  cross
                    ? 'stroke-(--el-warning)'
                    : running
                      ? // The dash + its travel are in `globals.css`, gated behind
                        // `prefers-reduced-motion: no-preference` — so the STATIC
                        // form is the default and reduced motion keeps this hue
                        // and weight without moving (MOTIR-3972).
                        'canvas-edge-running stroke-(--el-status-in-progress)'
                      : emph
                        ? 'stroke-(--el-accent-on-surface)'
                        : pending
                          ? 'stroke-(--el-canvas-edge-pending)'
                          : 'stroke-(--el-canvas-edge-committed)'
                }
                strokeWidth={
                  running ? 3 : lit && selectedId != null ? (cross ? 3.5 : 3) : cross ? 2.5 : 2
                }
                strokeLinecap="round"
                // a denser dash when emphasised keeps the dashed line legible at the
                // accent colour without losing the "pending" cue.
                strokeDasharray={pending ? (emph ? '5 6' : '2 7') : undefined}
                markerEnd={`url(#${mId}-${marker})`}
                vectorEffect="non-scaling-stroke"
                style={{ opacity: lit ? 1 : 0.12 }}
              />
            );
          })}
        </svg>

        {/* nodes — caller content; the canvas owns the box + drag */}
        <div className="absolute top-0 left-0" style={worldTransform} data-testid="canvas-world">
          {nodes.map((n) => {
            const r = rectOf(n);
            return (
              <div
                key={n.id}
                data-node-id={n.id}
                tabIndex={0}
                onKeyDown={
                  onNodeActivate
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onNodeActivate(n.id);
                        }
                      }
                    : undefined
                }
                ref={(el) => {
                  if (el) nodeEls.current.set(n.id, el);
                  else nodeEls.current.delete(n.id);
                }}
                className={`absolute rounded-(--radius-card) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent) ${
                  onNodeMove ? 'cursor-grab active:cursor-grabbing' : ''
                }`}
                style={{ left: r.x, top: r.y }}
              >
                {renderNode(n)}
              </div>
            );
          })}
        </div>

        {/* "blocked elsewhere" flag badges — the bad-plan SIGNAL, in their OWN layer (NOT
            the edge <svg>, whose <path> count is asserted): a warning chip + flag
            glyph + label at each cross edge's midpoint, so the tangle never rests
            on edge colour alone. Decorative — the dependency facts live in the
            node list. Rendered AFTER the node layer (MOTIR-1583) so the chip paints
            ABOVE the cards: both layers are position:absolute with no z-index, so a
            chip sitting at an edge's midpoint over a card would otherwise be occluded.
            The layer is pointer-events-none, so stacking it on top intercepts nothing. */}
        <div
          className="pointer-events-none absolute top-0 left-0"
          style={worldTransform}
          aria-hidden="true"
          data-testid="canvas-cross-flags"
        >
          {edges.map((edge, i) => {
            if (edge.variant !== 'cross') return null;
            const route = routes[i];
            if (!route) return null;
            const m = route.mid;
            return (
              <span
                key={`flag~${edge.from}~${edge.to}~${i}`}
                className="absolute inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-(--radius-badge) bg-(--el-warning-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium whitespace-nowrap text-(--el-warning-text) shadow-(--shadow-subtle)"
                style={{ left: m.x, top: m.y }}
                data-testid="cross-flag"
              >
                <Flag className="size-3.5" />
                {t('node.blockedElsewhere')}
              </span>
            );
          })}
        </div>
      </div>

      {/* zoom controls (fixed — do not pan/zoom) */}
      <div
        className="absolute bottom-4 left-4 flex overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-card)"
        role="group"
        aria-label={t('zoom')}
      >
        <ZoomButton label={t('zoomOut')} onClick={() => zoomCentred(1 / ZOOM_STEP)}>
          <Minus className="size-4" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={t('zoomIn')} onClick={() => zoomCentred(ZOOM_STEP)} bordered>
          <Plus className="size-4" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={t('fitToView')} onClick={doFit} bordered>
          <Maximize2 className="size-4" aria-hidden="true" />
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  bordered,
  children,
}: {
  label: string;
  onClick: () => void;
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex size-9 items-center justify-center text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) ${
        bordered ? 'border-l border-(--el-border-soft)' : ''
      }`}
    >
      {children}
    </button>
  );
}
