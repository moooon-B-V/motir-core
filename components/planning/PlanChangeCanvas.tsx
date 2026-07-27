'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { isProposedNodeId, type PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';

// The CANVAS pane of the plan-change conversation (Subtask MOTIR-1730; design
// panel 4 — "the review surface is the CANVAS, not a corner dock"). A sibling
// consumer of the reusable `ProjectRoadmapCanvas`, exactly like `WorkItemRoadmap`
// (the plain roadmap) and `PlanReviewCanvas` (the 7.21 plan detail): it reads the
// project ONE LEVEL AT A TIME from the shipped per-level endpoint (MOTIR-1010 —
// never a whole-forest load, `notes.html` #91), builds the level with the SHIPPED
// `buildWorkItemLevel`, and then layers the pending proposal onto it.
//
// It is its own consumer rather than a flag on `WorkItemRoadmap` for one concrete
// reason: a PROPOSED item is not a work item, so drilling into one must NOT hit
// the roadmap endpoint at all — its children live in the in-memory delta. That
// branch belongs to this flow, not to the plain roadmap.
//
// `diffKey` is the CLIENT-ISLAND refetch trigger (`motir-core/CLAUDE.md`): the
// canvas seeds its level once per `reloadKey`, so the host bumps this key when
// the proposal changes (a new delta arrives, or an approve commits it) and the
// current level re-renders in place — drill / zoom / pan preserved.

const ROOT_KEY = '__root__';
const EMPTY_LEVEL: RoadmapLevelData = { items: [], edges: [], offLevelBlockers: [] };

export interface PlanChangeCanvasProps {
  projectKey: string;
  /** The indexed pending proposal — empty index → a plain roadmap render. */
  index: PlanChangeDiffIndex;
  /** Bumped by the host whenever the proposal (or the committed tree) changed. */
  diffKey: string | number;
  ariaLabel?: string;
}

export function PlanChangeCanvas({ projectKey, index, diffKey, ariaLabel }: PlanChangeCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const { registerItems, onView, quickView } = useWorkItemQuickView();

  // Levels cached so re-drilling doesn't re-hit the API; a mutable ref, so a new
  // key simply misses. Cleared whenever the proposal key changes, since an approve
  // has committed items the cached level no longer describes.
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  const cacheKeyRef = useRef(diffKey);
  // id → work-item key, accumulated across the levels already fetched. Drilling
  // into a node requires having loaded the level that CONTAINS it, so by the time
  // it is the focus its key is known — which is how a proposed child parented by
  // `parentKey` finds its level.
  const keyByIdRef = useRef(new Map<string, string>());

  // `index` is a real dependency (not a ref): the canvas holds `loadLevel` in its
  // own ref and only re-runs it when the focus or `reloadKey` changes, so a new
  // proposal identity here is picked up by the `diffKey`-driven reload — with the
  // FRESH index, not a render-time ref that would lag that reload by one pass.
  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const diff = index;
      const focus = {
        focusNodeId: parentId,
        focusKey: parentId === null ? null : (keyByIdRef.current.get(parentId) ?? null),
      };

      // Drilled into a PROPOSED item: nothing is persisted, so there is no level to
      // read — its children come straight from the delta.
      if (parentId !== null && isProposedNodeId(parentId)) {
        return decoratePlanChangeLevel({ nodes: [], deps: [] }, EMPTY_LEVEL, diff, focus);
      }

      if (cacheKeyRef.current !== diffKey) {
        cacheKeyRef.current = diffKey;
        cacheRef.current.clear();
      }
      const cacheKey = `${projectKey}:${parentId ?? ROOT_KEY}`;
      let wi = cacheRef.current.get(cacheKey);
      if (!wi) {
        wi = await fetchRoadmapLevel(projectKey, parentId, 'project');
        cacheRef.current.set(cacheKey, wi);
      }
      registerItems(wi);
      for (const item of wi.items) keyByIdRef.current.set(item.id, item.identifier);

      return decoratePlanChangeLevel(buildWorkItemLevel(wi, { markActive: true }), wi, diff, focus);
    },
    [projectKey, diffKey, index, registerItems],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        // Re-runs the CURRENT level's load when the proposal changes, so the diff
        // appears (and disappears on approve/discard) without a remount.
        reloadKey={`plan-change:${diffKey}`}
        onView={onView}
        searchable
        fullScreenable
        locatable
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? t('ariaWorkItem')}
      />
      {quickView}
    </>
  );
}
