'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  LocateFixed,
  Maximize,
  Minimize,
  RotateCcw,
  Search,
} from 'lucide-react';
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
  /** Show the EXPAND-to-full-screen control (MOTIR-1420). The roadmap consumer opts
   *  in so a viewer can use the whole display for a large tree; onboarding does not.
   *  Takes the canvas full-viewport (via the Fullscreen API, with a fixed overlay as
   *  the always-deterministic base); ESC exits. */
  fullScreenable?: boolean;
  /** Show the LOCATE control (MOTIR-1421) — recentres the canvas on the actionable
   *  node: the "you are here" frontier first, else the ready-to-start nodes (cycling
   *  with wrap). The work-item roadmap opts in (its nodes carry `here` / `ready`);
   *  onboarding does not. */
  locatable?: boolean;
  /** The breadcrumb root label. */
  rootLabel?: string;
  ariaLabel?: string;
  /** Override the WARNING (red) edge legend row. Defaults to the "blocked
   *  elsewhere" meaning (MOTIR-1568); the sprint-scoped roadmap passes the "not in
   *  sprint" meaning so the legend matches the node flag + anchor (MOTIR-1379). */
  warningLegend?: { label: string; meaning: string };
  /**
   * SKIP A LEVEL THAT OFFERS NO CHOICE (MOTIR-1807). When a resolved level holds
   * EXACTLY ONE node and that node is `drillable`, descend into it instead of
   * rendering it — repeating while each newly-resolved level is again a single
   * drillable node, so an `epic → story → subtasks` chain compacts in ONE arrival.
   * The sprint-scoped read (MOTIR-1381) re-roots at the topmost in-sprint members, so
   * a sprint committed to one story's subtree hides the whole sprint behind one drill.
   *
   * "Exactly one node" counts the level's WORK — a node flagged `decorative` (the
   * pinned planning-origin cluster) is not a choice and does not hold the descent
   * back (MOTIR-1824).
   *
   * **Defaults to `false`, and that default is load-bearing.** This canvas is the
   * reusable FOUNDATION (MOTIR-1194) behind five consumers; an onboarding canvas that
   * silently walked past its single station would be a regression. Only the work-item
   * roadmap adapter opts in.
   *
   * The descent reuses the manual-drill transition EXACTLY, so an arrival is an
   * ordinary drilled view and nothing downstream can tell the two apart — the design
   * position drawn side by side in `design/roadmap/auto-drill.*` panel C.
   */
  autoDescendSingleParent?: boolean;
  /**
   * Replace what fills the canvas while the FIRST level is still being read
   * (MOTIR-2069). Defaults to the shipped centred spinner, which every other
   * consumer keeps. The planning workspace passes a level-shaped SKELETON
   * instead, because there the canvas is the surface the user is waiting on —
   * a skeleton says "your plan is arriving", a spinner says "something is
   * happening". Rendered in the same full-size box as the level it stands in
   * for, so filling it shifts nothing.
   */
  loadingFallback?: ReactNode;
  /**
   * Replace the ROOT level's empty state (MOTIR-2069) — what shows when the
   * project genuinely has nothing to draw. Defaults to the canvas's own copy.
   * The planning workspace passes its own, so an established-but-emptied
   * project gets the workspace's honest "nothing on the canvas yet" invitation
   * rather than the bare panel. Does NOT affect a DRILLED empty level, which is
   * a different statement ("this parent has no children").
   */
  emptyRoot?: ReactNode;
}

// The suppression ref (below) is keyed by LEVEL; the root level has no id.
const ROOT_LEVEL_KEY = '__root__';
const levelKey = (id: string | null) => id ?? ROOT_LEVEL_KEY;

interface Crumb {
  id: string;
  label: string;
}

// The readable default zoom the LOCATE control snaps to (MOTIR-1421) — 1× shows a
// node at its natural authored card size, comfortably legible regardless of how far
// the user had zoomed out/in.
const LOCATE_ZOOM = 1;

export function ProjectRoadmapCanvas({
  loadLevel,
  reloadKey,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  onView,
  searchable = false,
  fullScreenable = false,
  locatable = false,
  rootLabel,
  ariaLabel,
  warningLegend,
  autoDescendSingleParent = false,
  loadingFallback,
  emptyRoot,
}: ProjectRoadmapCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  // The breadcrumb root, the canvas aria label, and the WARNING legend row default
  // to the localized project-scope copy; a caller (e.g. the sprint-scoped roadmap)
  // overrides the warning row with its own "blocker not in sprint" copy (MOTIR-1379,
  // reworded MOTIR-1582 to name the blocker, not the card).
  const resolvedRootLabel = rootLabel ?? t('breadcrumbRoot');
  const resolvedAriaLabel = ariaLabel ?? t('ariaDefault');
  const resolvedWarningLegend = warningLegend ?? {
    label: t('legend.blockedElsewhere'),
    meaning: t('legend.blockedElsewhereMeaning'),
  };
  const [focusId, setFocusId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [level, setLevel] = useState<RoadmapLevel | null>(null);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  // The ZOOM the next focus pan should land at: `undefined` preserves the current
  // scale (the search-locate's pan-only behaviour); `LOCATE_ZOOM` resets to a readable
  // default so a node found while zoomed far out/in lands at a comfortable card size
  // (the locate control, MOTIR-1421).
  const [focusScale, setFocusScale] = useState<number | undefined>(undefined);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(
    {},
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // FULL-SCREEN (MOTIR-1420). `expanded` is the authoritative state and drives a
  // fixed full-viewport overlay — deterministic everywhere (and what the E2E
  // asserts). On top of that we BEST-EFFORT call the browser Fullscreen API so the
  // OS chrome hides too; if it rejects (e.g. headless / no user-gesture trust) the
  // overlay still fills the viewport, so the feature degrades cleanly.
  const [expanded, setExpanded] = useState(false);
  const reqSeq = useRef(0);
  // AUTO-DESCEND suppression (MOTIR-1807; design `auto-drill.*` panel F). `navigate()`
  // and `goBack()` are the user EXPLICITLY asking to see a level — if auto-descend then
  // fired again they'd be thrown straight back down and the breadcrumb root would be
  // unclickable. So remember WHICH level they climbed to and never descend out of it.
  // Keyed by level rather than a bare boolean so it SURVIVES A MANUAL REFRESH: the
  // refresh signal (MOTIR-1542) re-runs the load for that same level, and re-descending
  // would make Refresh feel like it lost the user's place. An explicit `handleDrill`
  // clears it (a deliberate drill RE-ARMS the behaviour, so a chain below still
  // compacts). A SCOPE switch re-arms by construction — `RoadmapView` remounts this
  // canvas on `key={scope}`, a fresh arrival with fresh refs.
  const suppressedLevelRef = useRef<string | null>(null);
  // The ids already on the crumb stack — the auto-descend's CYCLE GUARD. `loadLevel`
  // is consumer-supplied I/O, so a level that (wrongly) resolves to a node already in
  // our own descent path would otherwise descend forever, hanging the canvas rather
  // than failing visibly. Never descend into an ancestor; render the level instead.
  const crumbIdsRef = useRef<Set<string>>(new Set());
  // The opt-in flag, held in a ref so the load effect stays keyed strictly on level
  // identity (`focusId` / `reloadKey`) — toggling the prop must not refetch a level.
  const autoDescendRef = useRef(autoDescendSingleParent);
  useEffect(() => {
    autoDescendRef.current = autoDescendSingleParent;
  }, [autoDescendSingleParent]);

  const enterFullScreen = useCallback(() => {
    setExpanded(true);
    const el = rootRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
  }, []);
  const exitFullScreen = useCallback(() => {
    setExpanded(false);
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // ESC exits. Native fullscreen also handles ESC itself (caught by the
  // `fullscreenchange` sync below), but this covers the overlay-only path where the
  // Fullscreen API isn't active, so ESC always exits regardless.
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      exitFullScreen();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, exitFullScreen]);

  // Sync state when the user leaves native fullscreen by any route (the OS ESC, the
  // browser's own exit affordance) so the button + overlay collapse with it.
  useEffect(() => {
    function onFsChange() {
      if (typeof document !== 'undefined' && !document.fullscreenElement) {
        setExpanded(false);
      }
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  // Hold the latest loadLevel so the load effect refetches on focus / reloadKey —
  // NOT on the fetcher's identity (a consumer's loadLevel may be recreated each
  // render; `reloadKey` is the explicit "the data changed" signal).
  const loadLevelRef = useRef(loadLevel);
  useEffect(() => {
    loadLevelRef.current = loadLevel;
  }, [loadLevel]);
  // Mirror the crumb ids for the auto-descend's cycle guard (a ref, so the load
  // effect can read the current path without re-running on every crumb change).
  useEffect(() => {
    crumbIdsRef.current = new Set(crumbs.map((c) => c.id));
  }, [crumbs]);

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

  // THE drill transition — the ONE place a descent happens, shared by the explicit
  // "Open" affordance (`handleDrill`) and the auto-descend below. Keeping it single is
  // the point: a second drill path that drifts from the first is exactly how the
  // breadcrumb and the saved positions get out of sync, and it is what makes an
  // auto-arrival indistinguishable from a hand-drilled view (design panel C) — Back,
  // the breadcrumb, search, locate, zoom and full-screen all keep working with no
  // special case.
  const applyDrill = useCallback((node: ProjectCanvasNode) => {
    setCrumbs((c) => [...c, { id: node.id, label: node.crumbLabel ?? node.searchText }]);
    setLocalPositions({});
    setSelectedId(null);
    setFocusId(node.id);
    setHighlightId(null);
  }, []);

  // Fetch the current level. The PRIOR level stays visible during a refetch (no
  // flicker); a stale response (an out-of-order resolve) is discarded by sequence.
  useEffect(() => {
    const seq = ++reqSeq.current;
    let alive = true;
    void (async () => {
      try {
        const lvl = await loadLevelRef.current(focusId);
        // The out-of-order guard stays authoritative: a superseded response neither
        // renders NOR descends.
        if (!alive || seq !== reqSeq.current) return;
        // AUTO-DESCEND (MOTIR-1807) — a level of exactly ONE drillable node offers no
        // choice, so descend into it instead of rendering it. Deliberately does NOT
        // publish the skipped level first: `setLevel(lvl)` here would flash a card the
        // user never gets to act on. Leaving `level` untouched keeps the spinner (first
        // paint) or the previous level (a refetch) up until the level we actually LAND
        // on resolves — which is what makes a chained epic → story → subtasks descent
        // read as ONE arrival. The state change happens in this async CONTINUATION,
        // never as a synchronous setState in the effect body (the CI lint rule).
        //
        // The count is over the level's WORK, not its node array (MOTIR-1824): a
        // `decorative` node — the planning-origin cluster an ONBOARDED project pins
        // at its root level — is provenance drawn beside the road, not a branch in
        // it. Counting it made every onboarded project's root level two nodes, so
        // this feature silently never fired for them; the design's own rule for the
        // negative case is "there is a real branch; the choice is the user's"
        // (`auto-drill.mock.html` panel E), and a pinned annotation is neither.
        const choices = lvl.nodes.filter((n) => n.decorative !== true);
        const only = choices.length === 1 ? choices[0] : undefined;
        if (
          autoDescendRef.current &&
          only?.drillable === true &&
          suppressedLevelRef.current !== levelKey(focusId) &&
          !crumbIdsRef.current.has(only.id) // never descend back into an ancestor
        ) {
          applyDrill(only);
          return;
        }
        setLevel(lvl);
      } catch {
        if (alive && seq === reqSeq.current) setLevel({ nodes: [], deps: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [focusId, reloadKey, applyDrill]);

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
      // An explicit drill RE-ARMS auto-descend (design panel F): the user asked to go
      // down, so a single-parent chain below this node compacts again.
      suppressedLevelRef.current = null;
      // Drill: fetch the node's children (the load effect fires on focusId change).
      applyDrill(n);
    },
    [byId, applyDrill],
  );

  const navigate = useCallback((crumbId: string | null) => {
    // The user EXPLICITLY climbed to this level (a crumb click, or Back via `goBack`) —
    // never auto-descend out of it again, or the breadcrumb root becomes a trap.
    suppressedLevelRef.current = levelKey(crumbId);
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
    setFocusScale(undefined); // search-locate pans only — keep the user's zoom
    setHighlightId(target);
    setFocusNonce((n) => n + 1);
  }, [nodes, query]);

  // LOCATE control (MOTIR-1421) — centre the canvas on the ACTIONABLE node. The
  // targets come from the level's nodes: the "you are here" frontier first (a single
  // destination), else the READY nodes (cycled, wrapping). Centring reuses the same
  // pan-to-node machinery the search-locate above uses (highlight + focusNonce bump),
  // so the located node lights up AND is assertable on `data-highlighted`.
  const hereId = useMemo(() => nodes.find((n) => n.here)?.id ?? null, [nodes]);
  const readyIds = useMemo(() => nodes.filter((n) => n.ready).map((n) => n.id), [nodes]);
  const readySig = readyIds.join('|');
  const canLocate = hereId !== null || readyIds.length > 0;
  // The index of the ready node centred by the LAST locate click (-1 = none yet).
  const [locateIndex, setLocateIndex] = useState(-1);
  // Reset the cycle cursor when the level's targets change (a drill / re-plan) so the
  // cycle restarts cleanly — the React-sanctioned "adjust state during render when an
  // input changes" pattern (NOT a setState-in-effect, which the lint rule forbids).
  const targetSig = `${hereId ?? ''}|${readySig}`;
  const [prevTargetSig, setPrevTargetSig] = useState(targetSig);
  if (targetSig !== prevTargetSig) {
    setPrevTargetSig(targetSig);
    setLocateIndex(-1);
  }

  const locateActionable = useCallback(() => {
    // Locate snaps to a readable default zoom (so a node found while zoomed far
    // out/in lands at a comfortable size), then centres AND SELECTS the node — so its
    // actions (View / Open) surface and its connections light up, ready to act on.
    setFocusScale(LOCATE_ZOOM);
    // Frontier wins: a single destination, no cycling.
    if (hereId !== null) {
      setHighlightId(hereId);
      setSelectedId(hereId);
      setFocusNonce((n) => n + 1);
      return;
    }
    if (readyIds.length === 0) return;
    // Advance to the next ready node, wrapping after the last.
    const next = (locateIndex + 1) % readyIds.length;
    setLocateIndex(next);
    const targetId = readyIds[next] ?? null;
    setHighlightId(targetId);
    setSelectedId(targetId);
    setFocusNonce((n) => n + 1);
  }, [hereId, readyIds, locateIndex]);

  // The "n of m" cycling hint — shown only while cycling MULTIPLE ready nodes (no
  // frontier) and after the first locate, so it reflects the current position.
  const cyclingHint =
    hereId === null && readyIds.length > 1 && locateIndex >= 0
      ? `${locateIndex + 1} / ${readyIds.length}`
      : null;
  const locateLabel =
    hereId !== null
      ? t('locateCurrent')
      : readyIds.length > 1
        ? t('locateNextReady')
        : t('locateReady');

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
                aria-label={t('openChildren')}
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
    <div
      ref={rootRef}
      data-testid="roadmap-canvas"
      data-fullscreen={expanded || undefined}
      className={expanded ? 'fixed inset-0 z-50 bg-(--el-canvas)' : 'relative h-full w-full'}
    >
      {/* breadcrumb + Back overlay — only while drilled */}
      {drilled && (
        <nav
          aria-label={t('breadcrumb')}
          // Widened from 36rem with the `identifier · title` crumb label (MOTIR-1805
          // design DECISION 2) so a two-crumb chain reads without immediate ellipsis.
          className="absolute top-3 left-3 z-10 flex max-w-[min(44rem,calc(100%-1.5rem))] items-center gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-2 py-1 shadow-(--shadow-card)"
        >
          <button
            type="button"
            onClick={goBack}
            aria-label={t('back')}
            className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            <li className="shrink-0">
              <Crumb label={resolvedRootLabel} active={false} onClick={() => navigate(null)} />
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

      {/* TOP-RIGHT cluster: search-to-locate (within the current level) + the
          EXPAND-to-full-screen control, side by side (MOTIR-1420). */}
      {(searchable || fullScreenable) && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          {searchable && (
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                locate();
              }}
              className="w-60"
            >
              <Input
                ref={searchRef}
                type="search"
                aria-label={t('search')}
                placeholder={t('search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                addonStart={<Search className="size-4 text-(--el-text-muted)" aria-hidden="true" />}
              />
            </form>
          )}
          {fullScreenable && (
            <button
              type="button"
              data-testid="fullscreen-toggle"
              aria-label={expanded ? t('exitFullScreen') : t('enterFullScreen')}
              aria-pressed={expanded}
              onClick={expanded ? exitFullScreen : enterFullScreen}
              className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              {expanded ? (
                <Minimize className="size-4" aria-hidden="true" />
              ) : (
                <Maximize className="size-4" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      )}

      {/* ESC hint — only while full screen; the other overlay controls stay reachable. */}
      {expanded && (
        <div
          data-testid="fullscreen-hint"
          className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2"
        >
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-kbd) bg-(--el-muted) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs text-(--el-text-secondary) shadow-(--shadow-subtle)">
            Press
            <kbd className="rounded-(--radius-kbd) border border-(--el-border) bg-(--el-surface) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px] text-(--el-text)">
              Esc
            </kbd>
            to exit full screen
          </span>
        </div>
      )}

      {/* LOCATE control (MOTIR-1421) — recentres on the actionable node. Sits at the
          bottom-left, just RIGHT of the engine's zoom + fit cluster (bottom-4 left-4,
          ~7rem wide), so it reads as part of the viewport-navigation controls. */}
      {locatable && (
        <div className="absolute bottom-4 left-[8.25rem] z-10 flex items-center gap-2">
          <button
            type="button"
            data-testid="locate-button"
            aria-label={locateLabel}
            disabled={!canLocate}
            title={canLocate ? locateLabel : t('locateNothing')}
            onClick={locateActionable}
            // size-9 to match the engine's bottom-left zoom +/- buttons (also size-9)
            // exactly, so the locate control reads as part of that cluster.
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:bg-(--el-surface-soft) disabled:text-(--el-text-faint) disabled:shadow-(--shadow-subtle) disabled:hover:bg-(--el-surface-soft)"
          >
            <LocateFixed className="size-4" aria-hidden="true" />
          </button>
          {cyclingHint && (
            <span
              data-testid="locate-hint"
              className="inline-flex h-9 items-center rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-3 font-mono text-xs font-semibold text-(--el-text-secondary) shadow-(--shadow-card)"
            >
              {cyclingHint}
            </span>
          )}
        </div>
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
          {t('resetLayout')}
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
            {t('legend.heading')}
          </span>
          {(
            [
              ['committed', t('legend.blocks'), t('legend.blocksMeaning')],
              ['pending', t('legend.pending'), t('legend.pendingMeaning')],
              ['warning', resolvedWarningLegend.label, resolvedWarningLegend.meaning],
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
          {loadingFallback ?? <Spinner aria-label={t('loading')} />}
        </div>
      ) : nodes.length === 0 ? (
        !drilled && emptyRoot ? (
          // The consumer's own root-empty statement (MOTIR-2069), in the same
          // full-size box — a DRILLED empty level keeps the canvas's copy, since
          // "this parent has no children" is a different thing to say.
          <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
            {emptyRoot}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-(--el-canvas) p-6">
            <div className="max-w-[24rem] text-center">
              <p className="text-sm font-semibold text-(--el-text)">
                {drilled ? t('emptyDrilled') : t('emptyRootTitle')}
              </p>
              <p className="mt-1 text-sm text-(--el-text-muted)">
                {drilled ? t('emptyDrilledDescription') : t('emptyRootDescription')}
              </p>
            </div>
          </div>
        )
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
          focusScale={focusScale}
          ariaLabel={resolvedAriaLabel}
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
      // 18rem (was 12rem) for the `identifier · title` label (MOTIR-1805 DECISION 2).
      // Overflow stays the shipped answer: `truncate` + the native `title` tooltip — a
      // long chain ellipsises the last crumb BY DESIGN (not a second line, not a
      // smaller font).
      className={`max-w-[18rem] truncate rounded-(--radius-control) px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
        active
          ? 'font-semibold text-(--el-text)'
          : 'text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
      }`}
    >
      {label}
    </button>
  );
}
