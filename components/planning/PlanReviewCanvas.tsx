'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { mergePlanLevel, proposalsAtLevel } from '@/components/planning/planLevel';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { workItemCrumbLabel } from '@/lib/planning/projectCanvasModel';
import { ProposalQuickView } from '@/components/planning/ProposalQuickView';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The canvas pane of the plan detail (7.4.5 / MOTIR-847, redrawn by MOTIR-3083).
//
// It MOUNTS the reusable `ProjectRoadmapCanvas` (MOTIR-1194) — it does not redraw
// a canvas (#82) — and it now feeds that canvas the SAME thing the roadmap does:
// one committed LEVEL at a time, with this plan's proposals merged in.
//
// Before this it fed a forest built from the PlanItems alone, so the canvas
// showed the proposals and nothing else. A proposal parented under a committed
// item then drew at the top level, indistinguishable from a genuine root, and a
// reviewer could not see the siblings the new card would land beside.
//
// `loadLevel` is the roadmap's own per-level read (`GET /api/projects/<key>/
// roadmap?parentId=…`) with `mergePlanLevel` layered on it, which is exactly the
// build note in `design/roadmap/design-notes.md`: *"the consumer re-feeds the
// engine the children of the focused node + their same-level `blocked_by` edges,
// and tracks the breadcrumb path; the engine is unchanged."*
//
// `version` bumps `reloadKey` so the "live while generating" poll re-renders the
// current level as new PlanItems arrive.

export interface PlanReviewCanvasProps {
  items: PlanReviewItemDto[];
  /** The project the plan belongs to — the per-level roadmap read is keyed by it. */
  projectKey: string;
  /** Bumped by the parent on each poll update so the canvas refetches its level. */
  version: number;
  ariaLabel?: string;
}

/**
 * Where to OPEN the canvas: the committed parent the plan proposes into.
 *
 * A plan whose proposals sit under several committed parents has no single level
 * — that is the drill-down model working, not a gap — so the arrival level is the
 * one carrying the most proposals, and the rail remains the whole-plan list. A
 * plan that proposes only roots (or whose parents were archived, which resolves
 * to no parent at all) opens at the top level, exactly as a genuine root should.
 */
export function arrivalLevel(items: PlanReviewItemDto[]): { id: string; label: string } | null {
  const counts = new Map<string, { n: number; label: string }>();
  for (const item of items) {
    if (!item.parentNodeId || !item.parentIdentifier) continue;
    const prev = counts.get(item.parentNodeId);
    counts.set(item.parentNodeId, {
      n: (prev?.n ?? 0) + 1,
      label: workItemCrumbLabel(item.parentIdentifier, item.parentTitle ?? ''),
    });
  }
  let best: { id: string; label: string; n: number } | null = null;
  for (const [id, { n, label }] of counts) {
    if (!best || n > best.n) best = { id, label, n };
  }
  return best ? { id: best.id, label: best.label } : null;
}

export function PlanReviewCanvas({ items, projectKey, version, ariaLabel }: PlanReviewCanvasProps) {
  const arrival = useMemo(() => arrivalLevel(items), [items]);
  const initialTrail = useMemo<CanvasCrumb[] | undefined>(
    () => (arrival ? [{ id: arrival.id, label: arrival.label }] : undefined),
    [arrival],
  );

  // The DOOR (MOTIR-1351/1352): select a node → View → a peek. On every op.
  // An `add` peeks its PROPOSAL — there is no work item yet; anything else is an
  // ordinary committed node (a sibling, or a modify/remove's live target) and
  // gets the SHIPPED work-item peek, unchanged.
  const [peeked, setPeeked] = useState<{ proposal: PlanReviewItemDto | null; key: string | null }>({
    proposal: null,
    key: null,
  });
  const byNodeId = useMemo(() => new Map(items.map((i) => [i.nodeId, i])), [items]);
  const onView = useCallback(
    (nodeId: string) => {
      const proposal = byNodeId.get(nodeId);
      if (proposal && proposal.op === 'add') setPeeked({ proposal, key: null });
      else setPeeked({ proposal: null, key: proposal?.identifier ?? nodeId });
    },
    [byNodeId],
  );
  const closePeek = useCallback(() => setPeeked({ proposal: null, key: null }), []);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // The COMMITTED level. A failure here must not blank the review — the plan
      // is the page's subject and the surrounding tree is context — so it degrades
      // to "just this plan's proposals at that level", which is what the surface
      // showed before this change.
      let committed: RoadmapLevel = { nodes: [], deps: [] };
      try {
        // No project to read a level from — a pre-project discovery run
        // (`GenerationFlow`) proposes a tree before one exists, so there is no
        // committed neighbourhood and the proposals legitimately stand alone.
        if (!projectKey) return mergePlanLevel(committed, items, parentId);
        const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/roadmap${qs}`);
        if (res.ok) {
          const body = (await res.json()) as { nodes?: unknown; edges?: unknown };
          committed = {
            nodes: Array.isArray(body.nodes) ? (body.nodes as RoadmapLevel['nodes']) : [],
            deps: Array.isArray(body.edges) ? (body.edges as RoadmapLevel['deps']) : [],
          };
        }
      } catch {
        // Degraded above; nothing to add.
      }
      return mergePlanLevel(committed, items, parentId);
    },
    [items, projectKey],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        onView={onView}
        loadLevel={loadLevel}
        reloadKey={`${version}:${proposalsAtLevel(items, null).length}`}
        initialTrail={initialTrail}
        searchable
        rootLabel="Plan"
        ariaLabel={ariaLabel ?? 'Proposed plan'}
      />
      <ProposalQuickView item={peeked.proposal} onClose={closePeek} />
      <WorkItemQuickView peekKey={peeked.key} onClose={closePeek} />
    </>
  );
}
