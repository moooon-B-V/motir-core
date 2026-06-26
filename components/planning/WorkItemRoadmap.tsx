'use client';

import { useCallback, useRef } from 'react';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import {
  fetchRoadmapLevel,
  type RoadmapLevelData,
  type RoadmapScope,
} from '@/lib/planning/roadmapClient';

// The WORK-ITEM consumer of the reusable `ProjectRoadmapCanvas` (Subtask 7.20.2 /
// MOTIR-1194) — the adapter the persistent roadmap (MOTIR-1011) + the planning
// workspace (MOTIR-1193) mount. It reads the project roadmap ONE LEVEL AT A TIME
// from the per-level endpoint (MOTIR-1010) and renders each node as a
// `WorkItemNode`: the roots, then a node's children on drill, with the level's
// `blocked_by` edges drawn. The onboarding canvas is the OTHER consumer of the same
// foundation (stations + roots at the top level).
//
// It also OWNS the work-item quick-view peek (Subtask 7.20.11 / MOTIR-1352): the
// canvas surfaces a "View" button on the selected card, and this consumer opens the
// shipped peek (`WorkItemQuickView`) for that node — driven by LOCAL state, so the
// reusable canvas stays route-agnostic (no `?peek=` URL coupling).

const ROOT_KEY = '__root__';

export interface WorkItemRoadmapProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  /** Whole project (default) or the active-sprint slice (MOTIR-1382). Threaded
   *  into every per-level fetch as `&scope=sprint`. */
  scope?: RoadmapScope;
  /**
   * Pin the collapsed planning-origin cluster (MOTIR-1013) at the ROOT level —
   * gated by the caller on the project's immutable onboarding-ran marker
   * (Subtask 7.4 / MOTIR-1264). Only a project that actually onboarded shows it;
   * a never-onboarded project (existing tree, no materialized plan) omits it.
   * Defaults to false so a consumer that hasn't resolved the marker never asserts
   * a planning journey that didn't happen.
   */
  showPlanningOrigin?: boolean;
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  onResetPositions?: (nodeIds: string[]) => void;
  /** A LEAF work item (no children) was activated. */
  onSelect?: (id: string) => void;
  ariaLabel?: string;
}

export function WorkItemRoadmap({
  projectKey,
  scope = 'project',
  showPlanningOrigin = false,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  ariaLabel = 'Work-item roadmap',
}: WorkItemRoadmapProps) {
  // Levels cached so re-drilling a node doesn't re-hit the API. Keyed by
  // project+parent (a ref — mutable — so a new key just misses; no reset needed).
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  // The shared work-item quick-view peek (MOTIR-1352) — the same one the onboarding
  // canvas uses; opened by the canvas "View" button.
  const { registerItems, onView, quickView } = useWorkItemQuickView();

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // Scope is part of the cache key so a project-scope level is never reused
      // for sprint scope (MOTIR-1382). The page also remounts this component on a
      // scope change (its React `key`), so the canvas re-loads the ROOT in the new
      // scope; the scoped key is the belt-and-suspenders guard.
      const key = `${projectKey}:${scope}:${parentId ?? ROOT_KEY}`;
      let wi = cacheRef.current.get(key);
      if (!wi) {
        wi = await fetchRoadmapLevel(projectKey, parentId, scope);
        cacheRef.current.set(key, wi);
      }
      registerItems(wi);
      // The persistent roadmap marks the in-progress frontier "you are here" at
      // every level, and pins the collapsed planning-origin cluster at the ROOT
      // (the road's start) — Subtask 7.20.6 / MOTIR-1013 — but ONLY for a project
      // that actually onboarded (Subtask 7.4 / MOTIR-1264; `showPlanningOrigin`).
      return buildWorkItemLevel(wi, {
        markActive: true,
        includeOrigin: parentId === null && showPlanningOrigin,
      });
    },
    [projectKey, scope, registerItems, showPlanningOrigin],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        positions={positions}
        onNodeMove={onNodeMove}
        onResetPositions={onResetPositions}
        onSelect={onSelect}
        onView={onView}
        searchable
        rootLabel="Roadmap"
        ariaLabel={ariaLabel}
      />
      {quickView}
    </>
  );
}
