'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { PlanPreview } from '@/components/planning/PlanPreview';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { Spinner } from '@/components/ui/Spinner';
import { IdeaCard, StationCard } from './StationNode';
import { useCanvasLayout } from '@/lib/hooks/useCanvasLayout';
import { type DiscoveryState, shouldShowDesignStep } from '@/lib/onboarding/discoveryLoop';
import { type StationKind, type StationView, buildStations } from '@/lib/onboarding/canvasModel';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';
import {
  CANVAS_NODE_KEYS,
  STATION_EDGES,
  positionFor,
  type CanvasNodeKey,
} from '@/lib/onboarding/stationLayout';

// The onboarding canvas (Subtask 7.3.11 / MOTIR-840) — the LEFT pane of the hub,
// the pre-plan view of the project roadmap. It composes the reusable
// `ProjectRoadmapCanvas` FOUNDATION (7.20.2 / MOTIR-1194): the stations (idea →
// the four tiers → design / plan) are the TOP level beside the produced work-item
// roots; drilling a work item fetches its children ONE LEVEL AT A TIME from the
// per-level roadmap read (7.20.4 / MOTIR-1010). The 4 tier docs are part of the
// ONE project roadmap; build it once, every planning surface composes it.
//
// `loadLevel` is the consumer-owned per-level fetcher the foundation calls: the
// root level returns the stations (from the live discovery state) + the produced
// epics; a deeper level returns one parent's children. Work-item levels are cached
// per project so the stations refreshing (each chat turn) never re-hits the API.

const ROOT_KEY = '__root__';
// The synthetic top-level node that stands in for the whole produced plan — a
// compact "Your plan" PREVIEW (MOTIR-1333) instead of every epic fanned out. It
// hangs off the `plan` station and drills into the real epic roots on activate.
const PLAN_NODE_ID = '__plan__';
// The preview sits BELOW the station serpentine (which occupies up to ~y:800).
const ROOT_X0 = 40;
const ROOT_Y0 = 920;

export interface OnboardingCanvasProps {
  state: DiscoveryState;
  /** The seed idea (the idea node; omitted when absent — e.g. a resume). */
  idea: string | null;
  /** Re-open a produced tier's read-only review. */
  onOpen: (kind: DirectionDocKind) => void;
  /** Open the web-only design step (MOTIR-1040) — the `design` station's action. */
  onOpenDesign: () => void;
  /** The active project's key — the work-item tree is read per level from
   *  `/api/projects/[key]/roadmap?parentId=`. Omit (a pre-project state) and the
   *  canvas shows only the pre-plan stations. */
  projectKey?: string;
  /** The tier the conductor sent the user BACK to re-review (G3, MOTIR-1179). */
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

  // Work-item levels cached (a mutable ref, keyed by project+parent — a new key
  // just misses); the stations are rebuilt from state on every call, so they
  // always reflect the live loop.
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());

  // A signature of the station-relevant state; bumping it refetches the current
  // level so the stations refresh as tiers complete / the cascade moves.
  const reloadKey = useMemo(
    () =>
      JSON.stringify({
        produced: state.producedKinds,
        active: state.activeKind,
        deciding: state.pendingAsk !== null,
        working: state.working?.tier ?? null,
        status: state.session.status,
        platform: state.session.platform,
        idea: !!(idea && idea.trim()),
        revisitingKind,
        willRefresh,
        loaded,
      }),
    [state, idea, revisitingKind, willRefresh, loaded],
  );

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const r: LoadInputs = { state, idea, positions, revisitingKind, willRefresh, onOpenDesign };

      // The work-item READ for this level: the roots (the produced epics) back the
      // top-level PREVIEW and the synthetic plan level; else a parent's children.
      const readParent = parentId === null || parentId === PLAN_NODE_ID ? null : parentId;
      let wi: RoadmapLevelData = { items: [], edges: [], offLevelBlockers: [] };
      if (projectKey) {
        const key = `${projectKey}:${readParent ?? ROOT_KEY}`;
        const cached = cacheRef.current.get(key);
        if (cached) wi = cached;
        else {
          wi = await fetchRoadmapLevel(projectKey, readParent);
          cacheRef.current.set(key, wi);
        }
      }

      if (parentId !== null) {
        // The plan level (the epics) or a deeper work-item level — auto-laid out.
        return buildWorkItemLevel(wi);
      }

      // The ROOT level: the stations + (when the project has a tree) a compact
      // "Your plan" PREVIEW node — NOT the epics fanned out. It sits below the plan
      // station but is NOT wired to it: the work items are the user's own tree, not
      // something the planner station produced, so no edge points at it (the
      // plan→epic fan is the deferred onboarded-flag work, MOTIR-1013). Clicking it
      // drills into the full per-level tree (1333 design).
      const stationNodes = buildStationNodes(r);
      const stationDeps = buildStationDeps(r);
      const extra: ProjectCanvasNode[] = [];
      if (wi.items.length > 0) {
        extra.push({
          id: PLAN_NODE_ID,
          parentId: null,
          drillable: true,
          searchText: 'your plan',
          crumbLabel: 'Your plan',
          content: <PlanPreview epics={wi.items} />,
          x: ROOT_X0,
          y: ROOT_Y0,
        });
      }
      return { nodes: [...stationNodes, ...extra], deps: stationDeps };
    },
    [projectKey, state, idea, positions, revisitingKind, willRefresh, onOpenDesign],
  );

  const onActivate = useCallback(
    (id: string) => {
      const station = buildStations(state).find((s) => s.kind === id);
      // The design station opens the web-only design step — only once active (tiers
      // complete). A produced tier re-opens its read-only review. A work-item leaf
      // (a subtask) has no onboarding action yet.
      if (id === 'design') {
        if (station?.state === 'active') onOpenDesign();
        return;
      }
      if (station?.openable) onOpen(id as DirectionDocKind);
    },
    [state, onOpen, onOpenDesign],
  );

  // Hold a loading state until the saved positions resolve (MOTIR-1253).
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

  return (
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      reloadKey={reloadKey}
      onNodeMove={savePosition}
      onSelect={onActivate}
      searchable={!!projectKey}
      rootLabel={t('title')}
      ariaLabel={t('title')}
    />
  );
}

type LoadInputs = {
  state: DiscoveryState;
  idea: string | null;
  positions: Record<string, { x: number; y: number }>;
  revisitingKind: DirectionDocKind | null;
  willRefresh: DirectionDocKind[];
  onOpenDesign: () => void;
};

/** The pre-plan station nodes (idea → tiers → design / plan), from the live state. */
function buildStationNodes(r: LoadInputs): ProjectCanvasNode[] {
  const stations = buildStations(r.state);
  const stationByKind = new Map<StationKind, StationView>(stations.map((s) => [s.kind, s]));
  const showIdea = !!(r.idea && r.idea.trim());
  const showDesign = shouldShowDesignStep(r.state.session.platform);
  const keys = CANVAS_NODE_KEYS.filter((k) =>
    k === 'idea' ? showIdea : k === 'design' ? showDesign : true,
  );
  const willRefreshSet = new Set<string>(r.willRefresh);

  return keys.map((key) => {
    let content: ProjectCanvasNode['content'] = null;
    if (key === 'idea') {
      content = <IdeaCard idea={r.idea!.trim()} />;
    } else {
      const station = stationByKind.get(key as StationKind);
      if (station) {
        content = (
          <StationCard
            station={station}
            doc={r.state.docs[key]}
            session={r.state.session}
            onOpenDesign={
              station.kind === 'design' && station.state === 'active' ? r.onOpenDesign : undefined
            }
            revisiting={r.revisitingKind === key}
            refreshing={willRefreshSet.has(key)}
          />
        );
      }
    }
    return {
      id: key,
      parentId: null,
      searchText: key,
      drillable: false,
      content,
      ...positionFor(key, r.positions),
    };
  });
}

/** The pre-plan dependency chain among the present stations. */
function buildStationDeps(r: LoadInputs): ProjectCanvasDep[] {
  const stations = buildStations(r.state);
  const stationByKind = new Map<StationKind, StationView>(stations.map((s) => [s.kind, s]));
  const showIdea = !!(r.idea && r.idea.trim());
  const showDesign = shouldShowDesignStep(r.state.session.platform);
  const present = new Set<CanvasNodeKey>(
    CANVAS_NODE_KEYS.filter((k) => (k === 'idea' ? showIdea : k === 'design' ? showDesign : true)),
  );

  const reached = (key: CanvasNodeKey) =>
    key === 'idea' || stationByKind.get(key as StationKind)?.state !== 'upcoming';
  const variantOf = (from: CanvasNodeKey, to: CanvasNodeKey): ProjectCanvasDep['variant'] =>
    reached(from) && reached(to) ? 'firm' : 'pending';

  // `flow` edges: the station serpentine is a journey sequence, NOT a blocked-by
  // dependency, so it must not raise the dependency legend.
  const deps: ProjectCanvasDep[] = STATION_EDGES.filter(
    ([from, to]) => present.has(from) && present.has(to),
  ).map(([from, to]) => ({ from, to, variant: variantOf(from, to), kind: 'flow' }));
  if (!showDesign && present.has('validation') && present.has('plan')) {
    deps.push({
      from: 'validation',
      to: 'plan',
      variant: variantOf('validation', 'plan'),
      kind: 'flow',
    });
  }
  return deps;
}
