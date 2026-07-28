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
import { decorateTargetLevel } from '@/components/planning/PlanningTargetNode';
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
// the roadmap endpoint at all — its children live in the pending Plan the host
// read (MOTIR-1746). That branch belongs to this flow, not to the plain roadmap.
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
  /** The chat's planning TARGETS, by work-item id (MOTIR-1491) — the ones on the
   *  CURRENT level take the target ring, so the user sees what the planner is
   *  pointed at. */
  targetIds?: readonly string[];
  ariaLabel?: string;
}

export function PlanChangeCanvas({
  projectKey,
  index,
  diffKey,
  targetIds,
  ariaLabel,
}: PlanChangeCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const { registerItems, onView, quickView } = useWorkItemQuickView();

  // Levels cached so re-drilling doesn't re-hit the API; a mutable ref, so a new
  // key simply misses. Cleared whenever the proposal key changes, since an approve
  // has committed items the cached level no longer describes.
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  const cacheKeyRef = useRef(diffKey);

  // `index` is a real dependency (not a ref): the canvas holds `loadLevel` in its
  // own ref and only re-runs it when the focus or `reloadKey` changes, so a new
  // proposal identity here is picked up by the `diffKey`-driven reload — with the
  // FRESH index, not a render-time ref that would lag that reload by one pass.
  // The target set as a STABLE dependency: the prop is a fresh array on every
  // host render, so the joined key is what `loadLevel` (and the reload key
  // below) depend on — the level is rebuilt when the SET changes, not on every
  // keystroke in the composer.
  const targetKey = (targetIds ?? []).join(',');

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const diff = index;
      const targets = targetKey === '' ? [] : targetKey.split(',');

      // Drilled into a PROPOSED item: nothing is persisted, so there is no level to
      // read — its children come straight from the pending plan.
      if (parentId !== null && isProposedNodeId(parentId)) {
        // A proposed item's children are not work items, so none of them can be
        // a target — no target pass here.
        return decoratePlanChangeLevel({ nodes: [], deps: [] }, EMPTY_LEVEL, diff, parentId);
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

      // Targets are marked LAST, so the ring sits outside the diff frame when a
      // node is both targeted and touched by a pending proposal.
      return decorateTargetLevel(
        decoratePlanChangeLevel(buildWorkItemLevel(wi, { markActive: true }), wi, diff, parentId),
        targets,
      );
    },
    [projectKey, diffKey, index, registerItems, targetKey],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        // Re-runs the CURRENT level's load when the proposal — or the target set
        // — changes, so the diff and the target ring appear (and disappear)
        // without a remount, drill / zoom / pan preserved.
        reloadKey={`plan-change:${diffKey}:${targetKey}`}
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
