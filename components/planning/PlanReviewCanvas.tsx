'use client';

import { useCallback, useMemo } from 'react';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { buildPlanForest } from '@/components/planning/planLevel';
import { childrenOf, type ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The canvas pane of the plan detail (Subtask 7.4.5 / MOTIR-847): it MOUNTS the
// reusable `ProjectRoadmapCanvas` (MOTIR-1194) fed the plan's proposed items as
// data — it does NOT redraw a canvas (#82). The whole proposed forest is built
// once from the in-memory review model (a plan is a BOUNDED proposal set, not the
// project forest), and `loadLevel` slices it PER LEVEL so the canvas renders one
// drill level at a time (#91 — never a whole-tree dump on screen). `version` bumps
// `reloadKey` so the "live while generating" poll re-renders the current level as
// new PlanItems arrive.

export interface PlanReviewCanvasProps {
  items: PlanReviewItemDto[];
  /** Bumped by the parent on each poll update so the canvas refetches its level. */
  version: number;
  ariaLabel?: string;
  /** Open the inline-edit form for a proposed `add` (7.21.6 · MOTIR-1370). Passed
   *  only while the plan is `planned` (editable); each `add` node shows its trigger. */
  onEditAdd?: (planItemId: string) => void;
}

export function PlanReviewCanvas({ items, version, ariaLabel, onEditAdd }: PlanReviewCanvasProps) {
  const forest = useMemo(() => buildPlanForest(items, onEditAdd), [items, onEditAdd]);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const visible = childrenOf(forest.nodes, parentId);
      const visIds = new Set(visible.map((n: ProjectCanvasNode) => n.id));
      const deps = forest.deps.filter((d) => visIds.has(d.from) && visIds.has(d.to));
      return { nodes: visible, deps };
    },
    [forest],
  );

  return (
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      reloadKey={version}
      searchable
      rootLabel="Plan"
      ariaLabel={ariaLabel ?? 'Proposed plan'}
    />
  );
}
