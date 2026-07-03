'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
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
  /** A monotonic counter (MOTIR-1542): each increment is a MANUAL REFRESH — the
   *  consumer drops the level cache and bumps the canvas `reloadKey`, so the CURRENT
   *  level refetches IN PLACE (drill / breadcrumb / zoom / pan preserved), never a
   *  remount. Defaults to 0 (no refresh). */
  refreshSignal?: number;
  /** Called when a refresh-triggered refetch has SETTLED, so the caller can clear
   *  its loading affordance on the real fetch-completion signal (not a timer). */
  onRefreshSettled?: () => void;
}

export function WorkItemRoadmap({
  projectKey,
  scope = 'project',
  showPlanningOrigin = false,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  ariaLabel,
  refreshSignal = 0,
  onRefreshSettled,
}: WorkItemRoadmapProps) {
  const t = useTranslations('roadmap.canvas');
  // Levels cached so re-drilling a node doesn't re-hit the API. Keyed by
  // project+parent (a ref — mutable — so a new key just misses; no reset needed).
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  // The shared work-item quick-view peek (MOTIR-1352) — the same one the onboarding
  // canvas uses; opened by the canvas "View" button.
  const { registerItems, onView, quickView } = useWorkItemQuickView();

  // A MANUAL REFRESH (MOTIR-1542): the caller bumps `refreshSignal`, which folds into
  // the canvas `reloadKey` (below) so the canvas re-runs its load for the CURRENT
  // level. The cache invalidation + the completion signal both live INSIDE `loadLevel`
  // (a callback the canvas invokes), NOT in an effect: the canvas is a CHILD, so a
  // parent effect here would run AFTER the canvas had already re-read the stale cache.
  // `cacheGenRef` tracks the refresh generation the cache belongs to; `settledRef`
  // tracks the last generation whose load we reported settled.
  const cacheGenRef = useRef(refreshSignal);
  const settledRef = useRef(refreshSignal);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // A new refresh generation invalidates every cached level so this load hits the
      // API (the in-place refetch); a normal drill within a generation stays cached.
      if (refreshSignal !== cacheGenRef.current) {
        cacheGenRef.current = refreshSignal;
        cacheRef.current.clear();
      }
      try {
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
        // `scope` flips the off-level dependency signal from cross-story (project) to
        // the sprint-validity "not in sprint" signal (MOTIR-1379).
        return buildWorkItemLevel(wi, {
          markActive: true,
          includeOrigin: parentId === null && showPlanningOrigin,
          scope,
        });
      } finally {
        // A refresh-triggered load has completed → let the caller clear its loading
        // state on the authoritative fetch signal (`fetchRoadmapLevel` is best-effort,
        // so this always runs, even if the read degraded to an empty level). Guarded
        // per generation so only the refresh's own load settles it — an initial load
        // (generation 0) or a normal drill never fires it.
        if (refreshSignal !== settledRef.current) {
          settledRef.current = refreshSignal;
          onRefreshSettled?.();
        }
      }
    },
    [projectKey, scope, registerItems, showPlanningOrigin, refreshSignal, onRefreshSettled],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        // Fold the manual-refresh counter into the reload key so a refresh re-runs
        // the canvas's per-level load effect for the CURRENT level (MOTIR-1542).
        reloadKey={`${scope}:${refreshSignal}`}
        positions={positions}
        onNodeMove={onNodeMove}
        onResetPositions={onResetPositions}
        onSelect={onSelect}
        onView={onView}
        searchable
        fullScreenable
        locatable
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? t('ariaWorkItem')}
        warningLegend={
          scope === 'sprint'
            ? {
                label: t('legend.blockerNotInSprint'),
                meaning: t('legend.blockerNotInSprintMeaning'),
              }
            : undefined
        }
      />
      {quickView}
    </>
  );
}
