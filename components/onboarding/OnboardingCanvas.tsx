'use client';

import { useTranslations } from 'next-intl';
import { ProjectRoadmapCanvas } from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { Spinner } from '@/components/ui/Spinner';
import { IdeaCard, StationCard } from './StationNode';
import { useCanvasLayout } from '@/lib/hooks/useCanvasLayout';
import { useProjectRoadmap } from '@/lib/hooks/useProjectRoadmap';
import { type DiscoveryState, shouldShowDesignStep } from '@/lib/onboarding/discoveryLoop';
import { type StationKind, type StationView, buildStations } from '@/lib/onboarding/canvasModel';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';
import {
  CANVAS_NODE_KEYS,
  STATION_EDGES,
  positionFor,
  type CanvasNodeKey,
} from '@/lib/onboarding/stationLayout';

// The onboarding canvas (Subtask 7.3.11 / MOTIR-840) — the LEFT pane of the hub.
// It is the pre-plan view of the project roadmap: the stations (idea → the four
// tiers → design / plan slots) are nodes laid out in a space-filling serpentine
// and connected by the READ-ONLY dependency chain. The user can pan, zoom, and
// DRAG nodes; their arrangement persists per project (7.3.77, via
// `useCanvasLayout`). Clicking a produced tier re-opens its read-only review.
//
// It composes the reusable `ProjectRoadmapCanvas` FOUNDATION (7.20.2 / MOTIR-1194)
// — the SAME canvas the persistent roadmap and the planning workspace use for the
// produced epic → story → subtask tree. The 4 tier docs are part of the ONE
// project roadmap; this consumer feeds it the pre-plan stations (as the project
// grows past planning, the same canvas grows the work-item tree). Build it ONCE,
// every planning surface composes it.

// Parent-less work items (epics, or any orphan) lay out in a grid BELOW the
// station serpentine (which occupies up to ~y:800), so they show at the top level
// without colliding with the stations. They are NOT fanned from the plan node:
// these items are not necessarily produced by THIS onboarding. The "plan → epic"
// fan is correct only once a project carries the planned/onboarded (planning-
// origin) flag, which MOTIR-1013 introduces; until then a parent-less item is
// simply a top-level roadmap node.
const ROOT_COLS = 4;
const ROOT_X0 = 40;
const ROOT_Y0 = 920;
const ROOT_STEP_X = 360; // NODE_W (280) + gap
const ROOT_STEP_Y = 204; // NODE_H (132) + gap

export interface OnboardingCanvasProps {
  state: DiscoveryState;
  /** The seed idea (the idea node; omitted when absent — e.g. a resume). */
  idea: string | null;
  /** The active project's key — the work-item tree is read from
   *  `/api/projects/[key]/roadmap` and shown on the canvas (parent-less items at
   *  the top level, beside the stations). Omit (e.g. a pre-project state) and the
   *  canvas shows only the pre-plan stations. */
  projectKey?: string;
  /** Re-open a produced tier's read-only review. */
  onOpen: (kind: DirectionDocKind) => void;
  /** Open the web-only design step (MOTIR-1040) — the `design` station's action. */
  onOpenDesign: () => void;
  /** The tier the conductor sent the user BACK to re-review (G3, MOTIR-1179) —
   *  its station shows the "Revisiting" state. */
  revisitingKind?: DirectionDocKind | null;
  /** Downstream tiers re-deriving in the active cascade — "Will refresh". */
  willRefresh?: DirectionDocKind[];
}

export function OnboardingCanvas({
  state,
  idea,
  onOpen,
  onOpenDesign,
  projectKey,
  revisitingKind = null,
  willRefresh = [],
}: OnboardingCanvasProps) {
  const t = useTranslations('onboarding.chat.canvas');
  const { positions, savePosition, loaded } = useCanvasLayout();
  // The produced work-item forest (epics → stories → subtasks) for THIS project —
  // best-effort; empty until generation (7.4) produces a tree. The EPICS show at
  // the top level beside the stations (below the plan station, linked to it);
  // stories / subtasks drill out of their epic / story.
  const { items: workItems } = useProjectRoadmap(projectKey);
  const willRefreshSet = new Set<string>(willRefresh);

  // Hold a loading state until the saved positions resolve, so nodes never paint
  // at the auto-layout and then jump to the stored arrangement (MOTIR-1253).
  if (!loaded) {
    return (
      <div
        aria-busy="true"
        className="flex h-full w-full items-center justify-center bg-(--el-surface-soft)"
      >
        <Spinner aria-label={t('loading')} />
      </div>
    );
  }

  const stations = buildStations(state);
  const stationByKind = new Map<StationKind, StationView>(stations.map((s) => [s.kind, s]));

  const showIdea = !!(idea && idea.trim());
  // The design-phase gate (7.3.69): a mobile / other project's roadmap omits the
  // `design` station — the web design step doesn't apply (mobile is deferred,
  // 7.3.31). Web / desktop / not-yet-inferred keep it.
  const showDesign = shouldShowDesignStep(state.session.platform);
  const keys = CANVAS_NODE_KEYS.filter((k) =>
    k === 'idea' ? showIdea : k === 'design' ? showDesign : true,
  );
  const present = new Set<CanvasNodeKey>(keys);

  function contentFor(key: CanvasNodeKey) {
    if (key === 'idea') return <IdeaCard idea={idea!.trim()} />;
    const station = stationByKind.get(key as StationKind);
    if (!station) return null;
    return (
      <StationCard
        station={station}
        doc={state.docs[key]}
        session={state.session}
        // The design step is Step 5 — enterable only once the station is ACTIVE
        // (the tiers are complete); before then it's an upcoming roadmap node
        // with no entry CTA.
        onOpenDesign={
          station.kind === 'design' && station.state === 'active' ? onOpenDesign : undefined
        }
        revisiting={revisitingKind === key}
        refreshing={willRefreshSet.has(key)}
      />
    );
  }

  // The stations are one flat roadmap level (parent-less); their CONTENT is the
  // shipped StationCard / IdeaCard, and they own their serpentine positions (saved
  // arrangement overrides, via `positionFor`).
  const stationNodes: ProjectCanvasNode[] = keys.map((key) => ({
    id: key,
    parentId: null,
    searchText: key,
    content: contentFor(key),
    ...positionFor(key, positions),
  }));

  // The produced work items join the SAME canvas. Parent-less items (epics, or any
  // orphan) are ROADMAP ROOTS shown at the top level beside the stations, in a grid
  // below the serpentine so they don't collide. Stories / subtasks keep their parent
  // and auto-lay-out when their epic / story is drilled.
  const wiChildParents = new Set(workItems.filter((i) => i.parentId).map((i) => i.parentId!));
  const roots = workItems.filter((i) => i.parentId === null);
  const rootPos = new Map<string, { x: number; y: number }>();
  roots.forEach((r, i) => {
    const row = Math.floor(i / ROOT_COLS);
    const col = i % ROOT_COLS;
    rootPos.set(r.id, { x: ROOT_X0 + col * ROOT_STEP_X, y: ROOT_Y0 + row * ROOT_STEP_Y });
  });

  const workItemNodes: ProjectCanvasNode[] = workItems.map((item) => ({
    id: item.id,
    parentId: item.parentId,
    searchText: `${item.identifier} ${item.title}`,
    crumbLabel: item.identifier,
    content: <WorkItemNode item={item} drillable={wiChildParents.has(item.id)} />,
    ...(rootPos.get(item.id) ?? {}),
  }));

  const nodes: ProjectCanvasNode[] = [...stationNodes, ...workItemNodes];

  const deps: ProjectCanvasDep[] = STATION_EDGES.filter(
    ([from, to]) => present.has(from) && present.has(to),
  ).map(([from, to]) => ({ from, to, variant: edgeVariant(from, to, stationByKind) }));
  // Bridge the chain when the design station is gated out, so `plan` stays
  // connected: validation → plan replaces validation → design → plan.
  if (!showDesign && present.has('validation') && present.has('plan')) {
    deps.push({
      from: 'validation',
      to: 'plan',
      variant: edgeVariant('validation', 'plan', stationByKind),
    });
  }
  // NOTE: no `plan → epic` fan here — a parent-less work item stands on its own at
  // the top level. The fan (and the "you are here" planning-origin cluster) is gated
  // on the planned/onboarded flag and is MOTIR-1013's work.

  function onActivate(id: string) {
    // The design station opens the web-only design step (MOTIR-1040) — but only
    // once it is the active step (the tiers are complete); an upcoming design
    // station, like an upcoming tier, does not open. A produced tier re-opens its
    // read-only review.
    if (id === 'design') {
      if (stationByKind.get('design')?.state === 'active') onOpenDesign();
      return;
    }
    const station = stationByKind.get(id as StationKind);
    if (station?.openable) onOpen(id as DirectionDocKind);
  }

  return (
    <ProjectRoadmapCanvas
      nodes={nodes}
      deps={deps}
      onNodeMove={savePosition}
      onSelect={onActivate}
      // Once the project has a produced tree, the canvas is searchable (locate any
      // epic / story / subtask); a bare stations-only roadmap stays chrome-free.
      searchable={workItems.length > 0}
      ariaLabel={t('title')}
    />
  );
}

// A dependency edge is "firm" once both ends are reached (done / active), else a
// ghosted "pending" edge into the not-yet-drafted part of the roadmap.
function edgeVariant(
  from: CanvasNodeKey,
  to: CanvasNodeKey,
  byKind: Map<StationKind, StationView>,
): ProjectCanvasDep['variant'] {
  const reached = (key: CanvasNodeKey) =>
    key === 'idea' || byKind.get(key as StationKind)?.state !== 'upcoming';
  return reached(from) && reached(to) ? 'firm' : 'pending';
}
