'use client';

import { useTranslations } from 'next-intl';
import {
  PlanningCanvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/components/planning/PlanningCanvas';
import { Spinner } from '@/components/ui/Spinner';
import { IdeaCard, StationCard } from './StationNode';
import { useCanvasLayout } from '@/lib/hooks/useCanvasLayout';
import { type DiscoveryState } from '@/lib/onboarding/discoveryLoop';
import { type StationKind, type StationView, buildStations } from '@/lib/onboarding/canvasModel';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';
import {
  CANVAS_NODE_KEYS,
  STATION_EDGES,
  positionFor,
  type CanvasNodeKey,
} from '@/lib/onboarding/stationLayout';

// The onboarding canvas (Subtask 7.3.11 / MOTIR-840) — the LEFT pane of the hub.
// It composes the spatial `PlanningCanvas` (7.3.76): the pre-plan stations (idea →
// the four tiers → design / plan slots) are nodes laid out in a space-filling
// serpentine and connected by the READ-ONLY dependency chain. The user can pan,
// zoom, and DRAG nodes; their arrangement persists per project (7.3.77, via
// `useCanvasLayout`). Clicking a produced tier re-opens its read-only review.
//
// This REPLACES 833's minimal vertical placeholder canvas. The post-plan epic /
// story clusters on the same surface are a separate Epic-7 story (the design is
// built to accommodate them); here the canvas carries the pre-plan stations.

export interface OnboardingCanvasProps {
  state: DiscoveryState;
  /** The seed idea (the idea node; omitted when absent — e.g. a resume). */
  idea: string | null;
  /** Re-open a produced tier's read-only review. */
  onOpen: (kind: DirectionDocKind) => void;
  /** Open the web-only design step (MOTIR-1040) — the `design` station's action. */
  onOpenDesign: () => void;
}

export function OnboardingCanvas({ state, idea, onOpen, onOpenDesign }: OnboardingCanvasProps) {
  const t = useTranslations('onboarding.chat.canvas');
  const { positions, savePosition, loaded } = useCanvasLayout();

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
  const keys = CANVAS_NODE_KEYS.filter((k) => (k === 'idea' ? showIdea : true));
  const present = new Set<CanvasNodeKey>(keys);

  const nodes: CanvasNode[] = keys.map((key) => ({ id: key, ...positionFor(key, positions) }));
  const edges: CanvasEdge[] = STATION_EDGES.filter(
    ([from, to]) => present.has(from) && present.has(to),
  ).map(([from, to]) => ({ from, to, variant: edgeVariant(from, to, stationByKind) }));

  function renderNode(node: CanvasNode) {
    if (node.id === 'idea') return <IdeaCard idea={idea!.trim()} />;
    const station = stationByKind.get(node.id as StationKind);
    if (!station) return null;
    return (
      <StationCard
        station={station}
        doc={state.docs[node.id]}
        session={state.session}
        onOpenDesign={station.kind === 'design' ? onOpenDesign : undefined}
      />
    );
  }

  function onNodeActivate(id: string) {
    // The design station opens the web-only design step (MOTIR-1040); a produced
    // tier re-opens its read-only review.
    if (id === 'design') {
      onOpenDesign();
      return;
    }
    const station = stationByKind.get(id as StationKind);
    if (station?.openable) onOpen(id as DirectionDocKind);
  }

  return (
    <PlanningCanvas
      nodes={nodes}
      edges={edges}
      renderNode={renderNode}
      onNodeMove={savePosition}
      onNodeActivate={onNodeActivate}
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
): CanvasEdge['variant'] {
  const reached = (key: CanvasNodeKey) =>
    key === 'idea' || byKind.get(key as StationKind)?.state !== 'upcoming';
  return reached(from) && reached(to) ? 'firm' : 'pending';
}
