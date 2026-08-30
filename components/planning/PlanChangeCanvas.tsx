'use client';

import { useCallback, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { decorateTargetLevel } from '@/components/planning/PlanningTargetNode';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { workItemCrumbLabel, type CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import {
  isProposedNodeId,
  PROPOSED_NODE_PREFIX,
  type PlanChangeDiffIndex,
} from '@/lib/planning/planChangeDiff';

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
  /** The plan's DECISION, once it has one (MOTIR-3162) — the overlay SURVIVES
   *  the decision now, and this is what turns it into the decided treatment. */
  outcome?: PlanItemOutcome | null;
  /** The chat's planning TARGETS, by work-item id (MOTIR-1491) — the ones on the
   *  CURRENT level take the target ring, so the user sees what the planner is
   *  pointed at. */
  targetIds?: readonly string[];
  /** The level the canvas OPENS on, as a breadcrumb trail (MOTIR-2070) — the host
   *  passes the `?item=` anchor's ancestor chain, so a workspace summoned FROM a
   *  work item arrives on that item's own level instead of the project root, where
   *  its target ring would be drawn on a level nobody is looking at. Empty /
   *  omitted → the root, unchanged. */
  initialTrail?: readonly CanvasCrumb[];
  ariaLabel?: string;
  /** What fills the canvas while the first level is still being read
   *  (MOTIR-2069) — the workspace passes its level-shaped skeleton. */
  loadingFallback?: ReactNode;
  /** The workspace's own "nothing to draw yet" statement for an established but
   *  EMPTY project (MOTIR-2069). The canvas decides when to show it, off the
   *  level it reads itself — the page no longer reads the roots to pre-decide. */
  emptyRoot?: ReactNode;
}

export function PlanChangeCanvas({
  projectKey,
  index,
  diffKey,
  outcome = null,
  targetIds,
  initialTrail,
  ariaLabel,
  loadingFallback,
  emptyRoot,
}: PlanChangeCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const tWorkspace = useTranslations('planningWorkspace');
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
        return decoratePlanChangeLevel(
          { nodes: [], deps: [] },
          EMPTY_LEVEL,
          diff,
          parentId,
          outcome,
        );
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
        decoratePlanChangeLevel(
          buildWorkItemLevel(wi, { markActive: true }),
          wi,
          diff,
          parentId,
          outcome,
        ),
        targets,
      );
    },
    [projectKey, diffKey, index, registerItems, targetKey, outcome],
  );

  // ── The proposal's node ids CHANGE at approve, and the canvas holds one ─────
  //
  // A pending `add` draws as `proposed:<PlanItem id>`; once it has materialized
  // `isMaterializedAdd` is true, the prefix is dropped, and the node IS the
  // committed card (MOTIR-3206's fix — a second keyless copy of every accepted
  // card was the alternative). Right, and it re-keys the node.
  //
  // A user who has DRILLED INTO a proposed container is therefore left focused on
  // `proposed:<id>`, which after approve names no proposal and no work item: the
  // `isProposedNodeId` branch in `loadLevel` above answers from a diff whose
  // children have all moved onto the real cuid, so the level comes back empty
  // (bug MOTIR-3439). `PlanReviewCanvas` has the same defect under a different id
  // scheme, and both are answered by the same foundation prop rather than by two
  // local repairs.
  //
  // Only a MATERIALIZED add can match: a pending one still draws under the id
  // being asked about, and the resolver has to settle (its answer is never itself
  // a `proposed:` id, so the canvas is asked once and stops).
  const resolveHeldNode = useCallback(
    (id: string): CanvasCrumb | null => {
      if (!isProposedNodeId(id)) return null;
      const planItemId = id.slice(PROPOSED_NODE_PREFIX.length);
      const add = index.adds.find(
        (candidate) =>
          candidate.item.planItemId === planItemId &&
          candidate.item.identifier !== null &&
          !isProposedNodeId(candidate.nodeId),
      );
      if (!add?.item.identifier) return null;
      // A committed crumb, in the committed grammar — the bare title the proposed
      // node carried (`planChangeLevel.tsx`) was right only while there was no key
      // to put in front of it.
      return { id: add.nodeId, label: workItemCrumbLabel(add.item.identifier, add.item.title) };
    },
    [index],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        resolveHeldNode={resolveHeldNode}
        // Re-runs the CURRENT level's load when the proposal — or the target set
        // — changes, so the diff and the target ring appear (and disappear)
        // without a remount, drill / zoom / pan preserved.
        reloadKey={`plan-change:${diffKey}:${targetKey}:${outcome ?? 'pending'}`}
        // The anchored arrival (MOTIR-2070). A seed, read once at mount — the
        // reloads above re-run the CURRENT level, wherever the user has since
        // navigated to, and never drag them back here.
        initialTrail={initialTrail}
        onView={onView}
        searchable
        // This canvas draws the PROJECT with a pending proposal layered onto it,
        // so a reader searching here is searching the tree (MOTIR-4021, Part XIII
        // §5). The namespace is this feature's own, `planningWorkspace`.
        searchLabel={tWorkspace('searchLabel')}
        fullScreenable
        locatable
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? t('ariaWorkItem')}
        loadingFallback={loadingFallback}
        emptyRoot={emptyRoot}
      />
      {quickView}
    </>
  );
}
