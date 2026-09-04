'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
import { useDependencyLegendCollapsed } from '@/lib/hooks/useDependencyLegendCollapsed';
import { Spinner } from '@/components/ui/Spinner';
import { ARRIVAL_MIN_SCALE } from '@/lib/planning/canvasGeometry';
import {
  NODE_H,
  NODE_W,
  deterministicLayout,
  focalNode,
  searchMatches,
  type CanvasCrumb,
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
//
// It normally ARRIVES AT THE ROOT and drills from there. A consumer that already
// knows where the user is headed passes `initialTrail` (MOTIR-2070) and the canvas
// opens on that level with that breadcrumb — an ordinary drilled view, held in the
// same state a manual drill sets, so Back / the crumbs / search / locate need no
// special case.

export interface RoadmapLevel {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
}

interface ProjectRoadmapCanvasBaseProps {
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
  /**
   * SHOW CHANGES — an OPT-IN emphasis mode (MOTIR-3261,
   * `design/ai-planning/design-notes.md` Part IX §L).
   *
   * A plan proposing several cards onto one busy committed level draws them
   * correctly and gives the reader nothing to pick them out with. One control
   * fixes it: pressed, every id in `ids` takes the canvas's SHIPPED
   * selected/search-matched ring and every other node takes the SHIPPED
   * `opacity-35` dim. It is the same pair the wrapper already applies to ONE
   * node, applied to a SET — no second highlight vocabulary, no second dim value.
   *
   * ⚠️ OPT-IN, and absent by default, exactly as `searchable` / `fullScreenable`
   * / `locatable` are — an onboarding canvas that grew a Show-changes toggle
   * would be a regression. The consumer supplies BOTH the ids and the COPY,
   * because the foundation has no idea it is showing a plan and cannot name what
   * "the plan's changes" are.
   *
   * `total` is the plan's whole size, so the control can say `3 of 11` when the
   * level holds fewer than all of them (Part IX §L5). It offers no way to reach
   * the rest, deliberately: that is the list view's job.
   */
  emphasis?: {
    ids: string[];
    total: number;
    label: string;
    /** Shown as `title` + accessible description when there is nothing to
     *  emphasise on this level. */
    emptyLabel: string;
    /**
     * The other degenerate level (MOTIR-4020, Part XIII §3d): one made ENTIRELY of
     * the emphasised set, where an ON state rings every card and dims none.
     *
     * ⚠️ Part IX §L6 called that state *"correct and harmless"* and left the
     * control ENABLED, and it was right — of a state the reader CHOSE. Armed on
     * ARRIVAL the same screen arrives unasked, and a ring that is on everything
     * teaches the reader, at the moment they land, that the ring means nothing.
     * So both degenerate levels disable the control, and each says its own why.
     */
    allLabel: string;
    /**
     * What the LOCATE control walks, in the consumer's words (Part XIII §4).
     *
     * When `emphasis` is supplied the locate targets become the emphasised set on
     * this level — the same cards, ringed and walked, so the two controls cannot
     * drift into two answers about which are the plan's. The label is the
     * consumer's for the same reason `searchLabel` is (MOTIR-4021): the shipped
     * `here` / `ready` wording names a frontier a proposal never is.
     */
    locateLabel: string;
  };
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
  /**
   * ARRIVE ALREADY DRILLED (MOTIR-2070). The breadcrumb trail the canvas OPENS on,
   * root-ancestor first: the LAST crumb is the level it loads, and the whole array
   * becomes the breadcrumb. `[]` (the default) is the shipped behaviour — open at
   * the root — so every existing mount is untouched.
   *
   * The consumer supplies it because only the consumer knows the tree: the
   * planning workspace resolves its `?item=` anchor server-side and hands over
   * that anchor's ancestor chain, so the workspace opens on the level CONTAINING
   * the item it was summoned about instead of the project root, where the target
   * ring is drawn on a level nobody is looking at.
   *
   * Read ONCE, at mount — this is a seed, not a controlled level. Navigating the
   * canvas afterwards (drill / Back / a crumb click) is the user's, and a later
   * prop change must not yank them somewhere else. A caller that needs to re-seed
   * remounts on a `key`.
   */
  initialTrail?: readonly CanvasCrumb[];
  /**
   * REPORT the level (MOTIR-3835) — the other half of `initialTrail`.
   *
   * Fired whenever the canvas's OWN level moves, with the full trail root-first
   * (`[]` at the root level). There are exactly three movers and they funnel
   * through two functions: `applyDrill` — shared by the explicit "Open"
   * affordance AND the auto-descend, deliberately kept single — and `navigate`,
   * shared by a crumb click and `goBack`. So an AUTO-DESCENDED arrival
   * (MOTIR-1807) reports exactly like a hand-drilled one, which is the shipped
   * design position that an arrival must be indistinguishable from a drill.
   *
   * ⚠️ NOT fired for the mount-time `initialTrail` seed, and not fired when a
   * level LOAD resolves. The consumer supplied that trail; telling it what it
   * just said is a write loop waiting to happen.
   *
   * Absent by default — the four other consumers are untouched.
   */
  onLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  /**
   * A CONTROLLED level (MOTIR-3835) — the consumer moving the canvas IN PLACE.
   *
   * `initialTrail` above is a SEED, read once, and it is right about that: where
   * the canvas SITS is the user's. This prop is the other half, and the two
   * COMPOSE — the seed decides where the canvas opens, this decides where it is
   * moved to afterwards. While it is supplied the level is the CONSUMER's, and
   * the canvas adopts any value that differs from where it currently is.
   * `undefined` (the default) leaves the canvas uncontrolled; `[]` names the
   * root level. Passing both, agreeing at mount, is the ordinary case: the
   * arrival costs no adoption, and every later move is one.
   *
   * Adoption happens DURING RENDER — React's adjust-state-when-an-input-changes
   * pattern, the same one `remappedFocus` and `prevTargetSig` use — never a
   * `useEffect` + `setState`, which the CI lint rule
   * (`react-hooks/set-state-in-effect`) forbids and which would render one frame
   * of the old level first. It clears exactly what a drill clears
   * (`localPositions` / `selectedId` / `highlightId` / `showChanges`) and lets
   * the existing load effect read the new level: **no remount**, so the
   * consumer's level cache, the canvas chrome and the breadcrumb machinery all
   * survive, which is the whole reason this is not a `key`.
   *
   * An adopted level SUPPRESSES auto-descend for that level, exactly as
   * `navigate` does: a consumer asking for a level is asking to SEE it, not to
   * be carried past it. Suppression is per ADOPTION, not per controlled-ness —
   * a controlled canvas arriving at a root it was not moved to still
   * auto-descends normally.
   *
   * ⚠️ Not combinable with `resolveHeldNode`: that follows an id the canvas
   * HOLDS, and this replaces it, so a consumer using both would have the two
   * fight over `focusId`. No shipped consumer passes both.
   */
  controlledTrail?: readonly CanvasCrumb[];
  /**
   * ARRIVE AT A READABLE SCALE (MOTIR-3837) — opt-in, OFF by default.
   *
   * The engine already resets the scale on every level change (this component
   * remounts it per level, so it auto-fits to the new level's overview); what is
   * wrong without this is WHAT it resets to. `fitView` is clamped only by the
   * absolute `MIN_SCALE = 0.3`, so a level that cannot fit legibly is drawn at
   * 0.3× rather than not fitted — and the project root, with every epic on it, is
   * the surface most people open first.
   *
   * Opted in, a level whose fit lands below `ARRIVAL_MIN_SCALE` arrives AT that
   * floor, centred on this level's FOCAL card. The focal ladder is the LOCATE
   * control's own — the `here` frontier, then the first `ready` node, then the
   * level's first non-`decorative` node — so where the canvas OPENS and where
   * LOCATE takes you cannot drift apart.
   *
   * OFF by default because this canvas is the foundation behind four consumers and
   * only the work-item roadmap asks for it.
   */
  arriveAtReadableScale?: boolean;
  /**
   * FOLLOW a node the consumer RE-KEYS under a mounted canvas (bug MOTIR-3439).
   *
   * The canvas HOLDS two things by node id — its drilled `focusId` and every
   * crumb — and holds them in mount-time state, which `initialTrail` above
   * explains and is right about: where the canvas SITS is the user's, and a
   * later prop must not move them. That contract is about NAVIGATION. This prop
   * is about IDENTITY, which is a different thing and was not covered.
   *
   * A consumer whose node ids change under a mounted canvas — the plan detail is
   * the one that does, because approving a plan re-keys every proposal to the
   * work item it became (`planReviewService`, MOTIR-3160) — otherwise leaves the
   * focus and the crumbs pointing at ids that name nothing: `loadLevel` resolves
   * an empty level and the reader gets `emptyDrilled` on the level they were
   * standing on. Given an id the canvas holds, return what that id is NOW
   * (`{ id, label }`), or `null` for "not mine — leave it alone".
   *
   * It RE-ADDRESSES the level the canvas is already on and never MOVES it, so a
   * user who navigated elsewhere before the re-keying stays exactly where they
   * are. That is what makes this the right shape rather than a remount on a
   * `key`, which would re-seed and yank them.
   *
   * ⚠️ MUST BE IDEMPOTENT: applied to the id it just returned, it must return
   * that same id (or `null`). The canvas re-runs it after adopting a new id, and
   * a resolver that keeps renaming would not settle.
   */
  resolveHeldNode?: (id: string) => CanvasCrumb | null;
  /**
   * A one-line CAPTION for the level in view — `design/ai-planning` Part IX §1.4,
   * the `lvlcap` slot its mock draws (bug MOTIR-3453).
   *
   * The consumer supplies it because only the consumer knows what is worth saying
   * about a level; the canvas knows it has nodes, not what KIND of nodes they
   * are. Absent by default, so the foundation's other consumers are unchanged.
   *
   * It is NOT an empty state. `emptyDrilled` speaks for a level with nothing on
   * it; this speaks ABOUT a level that has something on it — the case it was
   * drawn for is a level made entirely of proposals, which is correct, looks like
   * nothing else on this surface, and must not be read as a failed load.
   */
  levelCaption?: ReactNode;
}

/**
 * SEARCH — opt-in, and turning it on REQUIRES saying what it SEARCHES
 * (MOTIR-4021, design Part XIII §5).
 *
 * The label is the CONSUMER's word, on both the `aria-label` and the
 * placeholder. It is a REQUIRING PAIR rather than an optional prop with a
 * default, and the difference is the whole card: this canvas has four searchable
 * mounts and exactly ONE of them is the roadmap, so a default of
 * `roadmap.canvas.search` is how *"Search the roadmap"* came to greet a reader on
 * `/plans/[id]`, on the plan-change canvas and in onboarding. A default cannot be
 * wrong loudly; a required field cannot be forgotten.
 *
 * The non-searchable arm forbids the label outright, so a mount that turns search
 * OFF cannot carry a dead string (the item page's Children panel is that mount,
 * deliberately — a `/` overlay inside an embedded panel is a page-level key grab).
 */
type ProjectRoadmapCanvasSearchProps =
  | { searchable: true; searchLabel: string }
  | { searchable?: false | undefined; searchLabel?: undefined };

export type ProjectRoadmapCanvasProps = ProjectRoadmapCanvasBaseProps &
  ProjectRoadmapCanvasSearchProps;

// The suppression ref (below) is keyed by LEVEL; the root level has no id.
const ROOT_LEVEL_KEY = '__root__';
const levelKey = (id: string | null) => id ?? ROOT_LEVEL_KEY;

interface Crumb {
  id: string;
  label: string;
  /** The work item's `<PREFIX>-<n>` key, when the node carried one (MOTIR-3835).
   *  Keeps this local shape assignable to the model's `CanvasCrumb`. */
  crumbKey?: string;
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
  searchLabel,
  fullScreenable = false,
  emphasis,
  locatable = false,
  rootLabel,
  ariaLabel,
  warningLegend,
  autoDescendSingleParent = false,
  loadingFallback,
  emptyRoot,
  initialTrail,
  onLevelChange,
  controlledTrail,
  arriveAtReadableScale = false,
  resolveHeldNode,
  levelCaption,
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
  // The ARRIVAL level (MOTIR-2070). A seeded trail's LAST crumb is the level the
  // canvas opens on; an absent / empty trail is the shipped root arrival. Both are
  // lazy initial state — read once at mount, never re-synced from the prop, so the
  // seed cannot fight the navigation the user does afterwards.
  const [focusId, setFocusId] = useState<string | null>(
    () => initialTrail?.[initialTrail.length - 1]?.id ?? null,
  );
  const [crumbs, setCrumbs] = useState<Crumb[]>(() => [...(initialTrail ?? [])]);
  // The level, TOGETHER WITH the focus it was loaded for (MOTIR-3837).
  //
  // ⚠️ THE TWO CANNOT BE SEPARATE, and separating them is a real bug rather than
  // untidiness. `focusId` moves the INSTANT a drill happens, while the level's
  // data arrives one round trip later — deliberately, so the prior level stays
  // visible instead of flashing. The engine below is remounted per level, and it
  // FITS ONCE on mount: keyed on `focusId`, the new instance mounts during that
  // window, sees the PREVIOUS level's nodes, fits THOSE, and marks itself
  // fitted — so the level the reader actually lands on is drawn at the scale of
  // the one they left. Keying on the focus the LEVEL belongs to closes the
  // window: the engine remounts exactly when the data it will fit has arrived,
  // and the prior level stays on screen until then, unchanged.
  const [level, setLevel] = useState<{ focusId: string | null; data: RoadmapLevel } | null>(null);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // SHOW CHANGES (MOTIR-3261) — a MODE, opt-in. It RESETS on every level change
  // alongside `selectedId` / `highlightId`, so a stale emphasis never survives a
  // drill or a Back.
  //
  // ⚠️ ARMED ON ARRIVAL (MOTIR-4020, Part XIII §3). What changed is the reset's
  // TARGET, not the reset: this is now an OVERRIDE over a per-level default
  // rather than a flag, so clearing it on a level change re-arms rather than
  // disarms. A reader who turns the emphasis off and then drills arrives armed
  // again, because the reset is per LEVEL and a drill is a new question about a
  // new set of cards — the same argument §L4 makes one tier down, where a
  // momentary SELECTION does not end the mode.
  const [showChangesOverride, setShowChangesOverride] = useState<boolean | null>(null);
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
  // The dependency-legend collapse (MOTIR-3838) — a per-VIEWER preference, shared
  // by every canvas that draws the legend and persisted on the shell's own
  // localStorage recipe. Not opt-in: the legend is this canvas's own chrome, and
  // giving two consumers a legend you can dismiss and two you cannot is a
  // distinction no reader could infer.
  const [legendCollapsed, toggleLegendCollapsed] = useDependencyLegendCollapsed();
  // A per-instance id, so `aria-controls` is unique when two canvases coexist.
  const legendRowsId = `${useId().replace(/:/g, '')}-legend-rows`;
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
  // A SEEDED arrival (`initialTrail`, MOTIR-2070) counts as that explicit ask: the
  // consumer aimed the canvas at this level because the thing the user is here for
  // lives ON it, so auto-descend must not immediately carry them past it.
  const suppressedLevelRef = useRef<string | null>(
    initialTrail && initialTrail.length > 0
      ? levelKey(initialTrail[initialTrail.length - 1]?.id ?? null)
      : null,
  );
  // The ids already on the crumb stack — the auto-descend's CYCLE GUARD. `loadLevel`
  // is consumer-supplied I/O, so a level that (wrongly) resolves to a node already in
  // our own descent path would otherwise descend forever, hanging the canvas rather
  // than failing visibly. Never descend into an ancestor; render the level instead.
  const crumbIdsRef = useRef<Set<string>>(new Set());
  // The crumbs themselves, for the level REPORTERS (MOTIR-3835) — see the sync
  // effect below for why a ref rather than a dependency.
  const crumbsRef = useRef<Crumb[]>(crumbs);

  // ── FOLLOW a RE-KEYED node (bug MOTIR-3439) ─────────────────────────────────
  //
  // The `resolveHeldNode` contract, applied. It runs DURING RENDER — React's
  // adjust-state-when-an-input-changes pattern, the same one `prevTargetSig`
  // below uses — rather than in a `useEffect`, which the CI lint rule
  // (`react-hooks/set-state-in-effect`) forbids and which would render one frame
  // of the dead level first anyway.
  //
  // Only the ADDRESS changes: the level the canvas is on, the depth of the
  // crumb stack and the user's place in it are all untouched, so this cannot
  // move anybody. The load effect fires on the new `focusId` and reads the level
  // the node became.
  const remappedFocus = focusId !== null ? (resolveHeldNode?.(focusId) ?? null) : null;
  if (remappedFocus !== null && remappedFocus.id !== focusId) setFocusId(remappedFocus.id);
  const remappedCrumbs = resolveHeldNode
    ? crumbs.map((crumb) => {
        const next = resolveHeldNode(crumb.id);
        return next && (next.id !== crumb.id || next.label !== crumb.label) ? next : crumb;
      })
    : crumbs;
  if (remappedCrumbs.some((crumb, i) => crumb !== crumbs[i])) setCrumbs(remappedCrumbs);

  // ── ADOPT a CONTROLLED level (MOTIR-3835) ───────────────────────────────────
  //
  // The mirror of `remappedFocus` directly above, and the same mechanism: an
  // adjust-state-during-render, never a `useEffect` + `setState`. The difference is
  // what each one is FOR — the remap changes a level's ADDRESS, this MOVES the
  // canvas — and this one is idempotent by construction: once the state settles,
  // `controlledFocusId === focusId` and the branch stops firing, so a re-render with
  // an unchanged value is a true no-op and cannot loop.
  const controlledFocusId =
    controlledTrail === undefined
      ? undefined
      : (controlledTrail[controlledTrail.length - 1]?.id ?? null);
  // The adoption EVENT, as state rather than a ref, because a ref may not be written
  // during render. Its object identity is what re-arms the suppression effect below,
  // so adopting the same level twice (drilled away, then restored) suppresses twice.
  const [adoption, setAdoption] = useState<{ level: string | null } | null>(null);
  if (controlledFocusId !== undefined && controlledFocusId !== focusId) {
    setFocusId(controlledFocusId);
    setCrumbs([...(controlledTrail ?? [])]);
    // Exactly what a drill / a `navigate` clears — an adopted level is a level
    // change, so nothing per-level may survive it.
    setLocalPositions({});
    setSelectedId(null);
    setHighlightId(null);
    setShowChangesOverride(null);
    setAdoption({ level: controlledFocusId });
  }
  // Record the suppression OUTSIDE render. Auto-descend must not carry the reader
  // out of a level the consumer explicitly asked for — the same rule `navigate`
  // applies for a crumb click, and the same `suppressedLevelRef` it writes.
  useEffect(() => {
    if (adoption !== null) suppressedLevelRef.current = levelKey(adoption.level);
  }, [adoption]);

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
  // Same reason, for the auto-descend suppression's level comparison below.
  const resolveHeldNodeRef = useRef(resolveHeldNode);
  useEffect(() => {
    resolveHeldNodeRef.current = resolveHeldNode;
  }, [resolveHeldNode]);
  // Same reason, for `onLevelChange` (MOTIR-3835): the reporters are `useCallback`s
  // with empty deps, and a consumer's handler is commonly recreated every render.
  const onLevelChangeRef = useRef(onLevelChange);
  useEffect(() => {
    onLevelChangeRef.current = onLevelChange;
  }, [onLevelChange]);
  // Mirror the crumb ids for the auto-descend's cycle guard (a ref, so the load
  // effect can read the current path without re-running on every crumb change).
  // `crumbsRef` mirrors the crumbs THEMSELVES for the same reason (MOTIR-3835):
  // `applyDrill` and `navigate` must report the trail they are producing, and they
  // hold no `crumbs` dependency by design — the functional `setCrumbs` updater is
  // what keeps them stable, and calling a consumer's callback from inside an updater
  // would fire it twice under StrictMode.
  useEffect(() => {
    crumbIdsRef.current = new Set(crumbs.map((c) => c.id));
    crumbsRef.current = crumbs;
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
    const crumb: Crumb = {
      id: node.id,
      label: node.crumbLabel ?? node.searchText,
      ...(node.crumbKey === undefined ? {} : { crumbKey: node.crumbKey }),
    };
    setCrumbs((c) => [...c, crumb]);
    setLocalPositions({});
    setSelectedId(null);
    setFocusId(node.id);
    setHighlightId(null);
    setShowChangesOverride(null);
    // REPORT the new level (MOTIR-3835). Computed from the crumbs ref rather than
    // inside the updater above: an updater may run twice (StrictMode), and a
    // consumer's callback is not something to fire twice. Because this is the ONE
    // drill transition, an auto-descended arrival reports identically to a
    // hand-drilled one — including each hop of a chained descent, which is what
    // makes the final report name the level actually landed on.
    onLevelChangeRef.current?.([...crumbsRef.current, crumb]);
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
        // The suppressed level is compared through `resolveHeldNode` as well: it
        // is keyed by LEVEL, and a re-keyed level is the SAME level under a new
        // address (bug MOTIR-3439), so a canvas that was told to stay put must
        // not descend out of it just because its id moved. Resolved HERE, at read
        // time, rather than rewritten when the focus is adopted — a ref may not
        // be touched during render.
        const suppressed = suppressedLevelRef.current;
        const suppressedNow =
          suppressed === null ? null : (resolveHeldNodeRef.current?.(suppressed)?.id ?? suppressed);
        if (
          autoDescendRef.current &&
          only?.drillable === true &&
          suppressedNow !== levelKey(focusId) &&
          !crumbIdsRef.current.has(only.id) // never descend back into an ancestor
        ) {
          applyDrill(only);
          return;
        }
        setLevel({ focusId, data: lvl });
      } catch {
        if (alive && seq === reqSeq.current) setLevel({ focusId, data: { nodes: [], deps: [] } });
      }
    })();
    return () => {
      alive = false;
    };
  }, [focusId, reloadKey, applyDrill]);

  const nodes = useMemo(() => level?.data.nodes ?? [], [level]);
  const deps = useMemo(() => level?.data.deps ?? [], [level]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const matchIds = useMemo(() => new Set(searchMatches(nodes, query)), [nodes, query]);

  // The emphasised ids that are actually ON this level. The consumer hands over
  // the whole plan's ids; the canvas is per-level, so the intersection is what it
  // can light — and its SIZE against `emphasis.total` is what the control says.
  const emphasisedIds = useMemo(() => {
    if (!emphasis) return new Set<string>();
    const onLevel = new Set(nodes.map((n) => n.id));
    return new Set(emphasis.ids.filter((id) => onLevel.has(id)));
  }, [emphasis, nodes]);

  // ⚠️ WHETHER THE EMPHASIS CAN SAY ANYTHING ON THIS LEVEL (MOTIR-4020, Part XIII
  // §3d). The ring means *this one and not that one*, so it needs both halves: at
  // least one of the plan's cards, AND at least one that is not. A level with
  // neither is a screen that says nothing — and, armed on arrival, one that says
  // nothing WITHOUT anybody having asked it to.
  const emphasisArmable = emphasisedIds.size > 0 && emphasisedIds.size < nodes.length;
  // The override is per level (it clears on every level change), so absent means
  // "as this level arrives" and present means "as the reader last set it here".
  const showChanges = showChangesOverride ?? emphasisArmable;
  const emphasisDisabledReason = emphasis
    ? emphasisedIds.size === 0
      ? emphasis.emptyLabel
      : emphasis.allLabel
    : undefined;

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
    setShowChangesOverride(null);
    if (crumbId === null) {
      setCrumbs([]);
      setFocusId(null);
      onLevelChangeRef.current?.([]);
      return;
    }
    const cur = crumbsRef.current;
    const i = cur.findIndex((x) => x.id === crumbId);
    const next = i >= 0 ? cur.slice(0, i + 1) : cur;
    setCrumbs(next);
    setFocusId(crumbId);
    onLevelChangeRef.current?.(next);
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
  //
  // ⚠️ WHEN `emphasis` IS SUPPLIED THE CONTROL WALKS THAT SET INSTEAD (MOTIR-4020,
  // Part XIII §4). A proposal is never `here` and never `ready`, so the shipped
  // ladder finds nothing on a plan canvas — the control was mounted on a surface
  // it could not serve. One prop, not two: the emphasis and the locate control are
  // the same set of cards seen twice, ringed and walked, and a second `locate` set
  // could drift from the first. In LAYOUT order, because the reader is walking a
  // picture and the walk should move the way the eye does — not in `op` order,
  // which jumps between three groups, nor in the plan's append order, which is
  // invisible on screen. `nodes` IS that order.
  const emphasisWalk = useMemo(
    () => (emphasis ? nodes.filter((n) => emphasisedIds.has(n.id)).map((n) => n.id) : null),
    [emphasis, nodes, emphasisedIds],
  );
  const hereId = useMemo(
    () => (emphasisWalk ? null : (nodes.find((n) => n.here)?.id ?? null)),
    [emphasisWalk, nodes],
  );
  const readyIds = useMemo(
    () => emphasisWalk ?? nodes.filter((n) => n.ready).map((n) => n.id),
    [emphasisWalk, nodes],
  );
  const readySig = readyIds.join('|');
  const canLocate = hereId !== null || readyIds.length > 0;
  // THE FOCAL CARD of this level (MOTIR-3837) — the node an arrival centres on when
  // the level cannot be shown legibly whole. The ladder is LOCATE's own, one line
  // up, so "where the canvas opens" and "where Locate takes you" cannot disagree:
  // the `here` frontier, else the first `ready` node, else the level's first node in
  // layout order. A `decorative` node — the pinned planning-origin cluster — is
  // never it, for the same reason it is not a level's WORK (MOTIR-1824).
  const focalNodeId = useMemo(() => focalNode(nodes), [nodes]);
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
  // The consumer's word when it supplied the set, for the same reason
  // `searchLabel` is (MOTIR-4021): the shipped strings name a READY frontier, and
  // a proposal is not one. The disabled reason is the emphasis control's own
  // (`emptyLabel`) — one sentence per situation, said once, rather than a second
  // wording for "the plan does not reach this level".
  const locateLabel = emphasis
    ? emphasis.locateLabel
    : hereId !== null
      ? t('locateCurrent')
      : readyIds.length > 1
        ? t('locateNextReady')
        : t('locateReady');
  const locateDisabledReason = emphasis ? emphasis.emptyLabel : t('locateNothing');

  function renderNode(cn: CanvasNode) {
    const node = byId.get(cn.id);
    if (!node) return null;
    const matched = highlightId === cn.id || matchIds.has(cn.id);
    const selected = cn.id === selectedId;
    // ⚠️ A LIVE SELECTION WINS while it lasts (Part IX §L4). Both mechanisms
    // write the same `connectedIds`-shaped state, and layering them gives three
    // opacity tiers and no legible meaning. The toggle stays pressed, so clearing
    // the selection restores the emphasis rather than making the reader re-arm
    // it: a selection is a momentary act, the toggle is a mode.
    const emphasised = showChanges && connectedIds === null && emphasisedIds.has(cn.id);
    const dimmed =
      connectedIds !== null
        ? !connectedIds.has(cn.id)
        : showChanges && emphasisedIds.size > 0 && !emphasisedIds.has(cn.id);
    return (
      <div
        data-highlighted={matched || undefined}
        data-selected={selected || undefined}
        data-emphasised={emphasised || undefined}
        className={[
          // `motion-reduce:transition-none` — turning the emphasis on changes the
          // opacity of most of the screen at once (Part IX §L8).
          'relative rounded-(--radius-card) transition-opacity motion-reduce:transition-none',
          // ⚠️ The ACCENT INK, never `--el-accent` (the FILL). A ring is a mark ON
          // `--el-surface-soft`, so it owes 3:1 against that offset — which the
          // fill missed in citrine (1.37), candy (1.51) and amber (1.74) light and
          // garnet dark (2.88). MOTIR-4474; measured in
          // `tests/theme/canvasEmphasisInkContrast.test.ts`, which reads the token
          // back out of this line.
          selected || matched || emphasised
            ? 'ring-2 ring-(--el-accent-on-surface) ring-offset-2 ring-offset-(--el-surface-soft)'
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

      {/* TOP-RIGHT cluster: search-to-locate (within the current level), the
          SHOW-CHANGES toggle (MOTIR-3261) and the EXPAND-to-full-screen control,
          side by side (MOTIR-1420).

          ⚠️ Show changes lives HERE and not in the plan detail's own pane header,
          which Part VIII had reserved for it. Part IX §L1 released that slot: the
          control acts on the canvas's NODES and belongs adjacent to what it
          changes; it must not exist in the list view, which this cluster gets for
          free; and the emphasis state lives in this component, so a control in
          another one would have to lift it out. */}
      {(searchable || fullScreenable || emphasis) && (
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
                // The CONSUMER's word, on both axes (MOTIR-4021). The foundation
                // has four searchable mounts and knows which surface it is on for
                // exactly none of them.
                aria-label={searchLabel}
                placeholder={searchLabel}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                addonStart={<Search className="size-4 text-(--el-text-muted)" aria-hidden="true" />}
              />
            </form>
          )}
          {emphasis && (
            <button
              type="button"
              data-testid="show-changes-toggle"
              aria-pressed={showChanges}
              // A level the plan does not reach: DISABLED with its reason, rather
              // than an ON state that dims every card and rings none — a screen
              // that says nothing is worse than a control that says why it cannot
              // help (Part IX §L6).
              // BOTH degenerate levels, each with its OWN reason (Part XIII §3d):
              // a level the plan does not reach, where ON would dim every card and
              // ring none; and a level made entirely OF the plan, where ON rings
              // every card and dims none. Same disposition, opposite emptiness.
              disabled={!emphasisArmable}
              title={emphasisArmable ? undefined : emphasisDisabledReason}
              aria-description={emphasisArmable ? undefined : emphasisDisabledReason}
              onClick={() => setShowChangesOverride(!showChanges)}
              className={[
                'inline-flex h-(--height-control) shrink-0 items-center gap-1.5 rounded-(--radius-btn)',
                'border px-(--spacing-control-x) text-xs font-semibold shadow-(--shadow-card)',
                'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                showChanges
                  ? // ⚠️ `--el-tint-lavender`, NOT `--el-accent-soft` (MOTIR-4020, Part
                    // XIII §3e). The latter is defined NOWHERE — it began as a LOCAL
                    // variable in Part IX's own mock (`#f4f2fd`, a hex in neither
                    // `theme.css` nor `globals.css`) that the note transcribed into the
                    // `--el-*` namespace, and this class built faithfully. An unresolved
                    // custom property is invalid at computed-value time, so the
                    // declaration was dropped and the PRESSED control rendered with no
                    // background at all — measured `rgba(0, 0, 0, 0)`. This pair is the
                    // shipped active-destination treatment (`components/ui/Sidebar.tsx`)
                    // and its contrast against `--el-accent-on-surface` is already
                    // asserted by `inkContrastLint` over every palette x theme.
                    'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-accent-on-surface)'
                  : 'border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)',
              ].join(' ')}
            >
              <Eye className="size-4" aria-hidden="true" />
              {emphasis.label}
              {/* `n of m` only when the level holds fewer than the whole plan —
                  the canvas is per-level and most of a spread plan is off-screen.
                  It offers no way to reach the rest, deliberately: that is the
                  list view's job (Part IX §L5).

                  ⚠️ Through the CATALOGUE, not composed here (bug MOTIR-3453).
                  This shipped as `{n}/{total}` built in JSX — a string no
                  catalogue could reach, so `zh` could never differ from `en` and
                  the parity gate could not see it, because there was no key for
                  it to find missing. Part IX §5 names the key and its wording:
                  `{n} of {total}`, which is also what a screen reader should
                  say. */}
              {emphasisedIds.size < emphasis.total ? (
                <span className="font-mono text-[11px] font-semibold tabular-nums">
                  {t('showChangesCount', { n: emphasisedIds.size, total: emphasis.total })}
                </span>
              ) : null}
            </button>
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
            title={canLocate ? locateLabel : locateDisabledReason}
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
          // THE ONE control the fold can collide with (MOTIR-3839). Every other
          // bottom-anchored overlay on this canvas is anchored LEFT; the floating
          // Plan-with-AI orb is `fixed right-5 bottom-5`, 56px square — a 76px
          // reach from both edges — so only a bottom-RIGHT control can meet it.
          // `--canvas-fold-inset` is declared by a consumer whose box SPENDS the
          // shell's clearance band (today: the roadmap page); it defaults to `0px`,
          // so every other mount — the item page's Children panel, the two plan
          // canvases — is exactly where it is now.
          className="absolute right-3 bottom-[calc(1rem+var(--canvas-fold-inset,0px))] z-10 inline-flex items-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) shadow-(--shadow-card) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t('resetLayout')}
        </button>
      )}

      {/* LEVEL CAPTION (bug MOTIR-3453) — Part IX §1.4's `lvlcap` slot, which the
          design's mock draws and the canvas never had. Composed as the edge
          LEGEND below already composes a canvas overlay: the same `--el-surface`
          chip with the canvas's border and shadow, and the same 10.5px tracked
          uppercase ramp, so a second overlay language is not invented for one
          line of text.

          ⚠️ The ink is `--el-text-secondary`, where the mock's `.lvlcap` rule
          says `var(--accent)`. That is the one deliberate deviation, and it is
          `CLAUDE.md`'s contrast rule doing its job — *"a design mock is NOT
          authority here"*. `--el-accent-on-surface` is specified as the accent
          used as text on a SURFACE, and this caption rides `--el-canvas`, a
          RECESSED board that every `data-palette` redefines; nothing measures
          that pairing, and there are eight palettes to be wrong in.
          `--el-text-secondary` is the token whose own definition carries the
          guarantee ("AA on EVERY surface"), and it is what the legend beside it
          already uses over the same canvas. Nothing is lost: the distinction
          this caption draws lives in its WORDS, which is what Part IX §1.3 asks
          for one decision earlier — text first, never colour alone.

          Sits UNDER the breadcrumb while drilled and takes its place when not,
          so it never collides with the overlay above it. Suppressed while the
          first level is still loading: a caption over a spinner describes a
          level nobody can see.

          ⚠️ The offset is DERIVED, and it is measured against the whole TOP
          BAND, not just the breadcrumb. Two overlays live at `top-3`: the
          breadcrumb on the left (while drilled) and the search / full-screen /
          Show-changes cluster on the right. Both are `--height-control` tall
          plus their own padding, and that token is 34–40px across the shipped
          styles — so the mock's literal 56px clears them under some styles and
          lands INSIDE them under others, and a caption wide enough to reach the
          right edge would run under the cluster at any offset. The mock's crumb
          is smaller than the shipped one; what it specifies is the RELATIONSHIP
          (the caption sits just below the chrome), and a `calc` off the same
          token is how that survives a style swap. */}
      {levelCaption && level !== null && (
        <div
          data-testid="level-caption"
          data-below-chrome={drilled || searchable || fullScreenable || !!emphasis || undefined}
          className={[
            'absolute left-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))]',
            // 12px band top + the overlay's own height (`--height-control` plus
            // 8px of padding) + an 8px gap. Only a canvas with an EMPTY top band
            // — no breadcrumb and no cluster — can take the band itself.
            drilled || searchable || fullScreenable || emphasis
              ? 'top-[calc(var(--height-control)+1.75rem)]'
              : 'top-3',
            'rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-3 py-2 shadow-(--shadow-card)',
          ].join(' ')}
        >
          <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
            {levelCaption}
          </span>
        </div>
      )}

      {/* edge LEGEND — shown when the level has real blocked-by DEPENDENCY edges,
          so the canvas is self-documenting (MOTIR-1331). Sequence/`flow` edges (the
          onboarding station serpentine) are excluded — they are drawn, but they are
          not dependencies. Sits above the engine's bottom-left zoom. */}
      {deps.some((d) => d.kind !== 'flow') && (
        <div
          data-testid="edge-legend"
          data-collapsed={legendCollapsed || undefined}
          className="absolute bottom-[4.25rem] left-3 z-10 flex flex-col gap-1.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-3 py-2 shadow-(--shadow-card)"
        >
          {/* COLLAPSE (MOTIR-3838). The chevron rides the panel's OWN heading row
              rather than being a bare pill beside it: the heading is the one thing
              that must survive the collapse — a legend that vanishes entirely
              cannot be brought back — so the control belongs next to it. The panel
              collapses IN PLACE: the slot is unchanged, so the control does not
              move under the reader's cursor and can never land on the engine's
              zoom cluster at `bottom-4 left-4`. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
              {t('legend.heading')}
            </span>
            <button
              type="button"
              data-testid="edge-legend-toggle"
              onClick={toggleLegendCollapsed}
              aria-expanded={!legendCollapsed}
              aria-controls={legendRowsId}
              aria-label={t(legendCollapsed ? 'legend.expand' : 'legend.collapse')}
              title={t(legendCollapsed ? 'legend.expand' : 'legend.collapse')}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {legendCollapsed ? (
                <ChevronUp className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          <div
            id={legendRowsId}
            hidden={legendCollapsed}
            className={legendCollapsed ? undefined : 'flex flex-col gap-1.5'}
          >
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
                <span className="text-(--el-text-secondary)">· {meaning}</span>
              </span>
            ))}
          </div>
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
          // Keyed on the focus the LEVEL belongs to, NOT on `focusId` — see the
          // note on the `level` state above. The two differ for exactly one round
          // trip, and that window is where the arrival scale was being lost.
          key={`level:${level.focusId ?? 'root'}`}
          nodes={canvasNodes}
          edges={canvasEdges}
          renderNode={renderNode}
          onNodeMove={onNodeMove ? handleMove : undefined}
          onNodeActivate={handleActivate}
          selectedId={selectedId}
          arrival={arriveAtReadableScale ? { floor: ARRIVAL_MIN_SCALE, focalNodeId } : undefined}
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
