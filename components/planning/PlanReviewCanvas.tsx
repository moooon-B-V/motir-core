'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { mergePlanLevel, proposalsAtLevel } from '@/components/planning/planLevel';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { fetchRoadmapLevel } from '@/lib/planning/roadmapClient';
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
// `loadLevel` is the roadmap's own per-level read composed through the SHIPPED
// ADAPTERS, with `mergePlanLevel` layered on it — which is exactly the build note
// in `design/roadmap/design-notes.md`: *"the consumer re-feeds the engine the
// children of the focused node + their same-level `blocked_by` edges, and tracks
// the breadcrumb path; the engine is unchanged."*
//
// ⚠️ THE ADAPTERS ARE THE REUSE, NOT THE ROUTE (bug MOTIR-3152). This function
// used to `fetch` the roadmap endpoint itself and CAST the wire DTO to the canvas
// view model. The two shapes share no field name: `RoadmapNodeDto` carries
// `identifier` / `status` / `isDone`, and `ProjectCanvasNode` needs `content` /
// `searchText` / `drillable` / `crumbLabel`. The cast was from `unknown`, so
// nothing type-checked it and nothing failed — every committed node arrived with
// an undefined `content`, which `renderNode` painted into a 0×0 box. The card was
// not blank, it was INVISIBLE; no `drillable` meant no Open pill and so no way
// down; no `searchText` made the search box throw; and the edges, still
// `{ blockedId, blockerId }`, were dropped by the layout's id filter. So the
// committed level goes through `fetchRoadmapLevel` + `buildWorkItemLevel` — the
// same pair `PlanChangeCanvas` composes — and nothing here builds a canvas node
// by hand.
//
// `version` bumps `reloadKey` so the "live while generating" poll re-renders the
// current level as new PlanItems arrive.

export interface PlanReviewCanvasProps {
  items: PlanReviewItemDto[];
  /** The project the plan belongs to — the per-level roadmap read is keyed by it. */
  projectKey: string;
  /** Bumped by the parent on each poll update so the canvas refetches its level. */
  version: number;
  /** The plan's DECISION, once it has one (MOTIR-3161) — drawn on the plan's own
   *  nodes, never on the committed neighbours it decided nothing about. */
  outcome?: PlanItemOutcome | null;
  ariaLabel?: string;
}

/**
 * Where to OPEN the canvas: the committed parent the plan proposes into, plus the
 * committed ANCESTOR PATH down to it (bug MOTIR-3152).
 *
 * A plan whose proposals sit under several committed parents has no single level
 * — that is the drill-down model working, not a gap — so the arrival level is the
 * one carrying the most proposals, and the rail remains the whole-plan list. A
 * plan that proposes only roots (or whose parents were archived, which resolves
 * to no parent at all) opens at the top level, exactly as a genuine root should.
 *
 * ⚠️ The trail is the WHOLE CHAIN, not one crumb. The design asks for *"the
 * committed ancestor path down to the focused level, exactly as the roadmap draws
 * it"* (`design/ai-planning/design-notes.md` Part V §2 panel E), and a chain has
 * to be CARRIED — `parentTrail` on the review model — rather than synthesised
 * from the immediate parent, which is all this function used to have. An EMPTY
 * trail beside a non-null parent means the chain could not be resolved (an
 * archived ancestor); that degrades to the single crumb the parent fields still
 * name, so the canvas never arrives with no breadcrumb at all.
 */
export function arrivalLevel(
  items: PlanReviewItemDto[],
): { id: string; trail: CanvasCrumb[] } | null {
  const counts = new Map<string, { n: number; trail: CanvasCrumb[] }>();
  for (const item of items) {
    if (!item.parentNodeId || !item.parentIdentifier) continue;
    const prev = counts.get(item.parentNodeId);
    const carried = item.parentTrail.map((c) => ({
      id: c.id,
      label: workItemCrumbLabel(c.identifier, c.title),
    }));
    counts.set(item.parentNodeId, {
      n: (prev?.n ?? 0) + 1,
      trail:
        carried.length > 0
          ? carried
          : [
              {
                id: item.parentNodeId,
                label: workItemCrumbLabel(item.parentIdentifier, item.parentTitle ?? ''),
              },
            ],
    });
  }
  let best: { id: string; trail: CanvasCrumb[]; n: number } | null = null;
  for (const [id, { n, trail }] of counts) {
    if (!best || n > best.n) best = { id, trail, n };
  }
  return best ? { id: best.id, trail: best.trail } : null;
}

export function PlanReviewCanvas({
  items,
  projectKey,
  version,
  outcome = null,
  ariaLabel,
}: PlanReviewCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const arrival = useMemo(() => arrivalLevel(items), [items]);
  const initialTrail = useMemo<CanvasCrumb[] | undefined>(
    () => arrival?.trail ?? undefined,
    [arrival],
  );

  // The DOOR (MOTIR-1351/1352): select a node → View → a peek. On every op.
  // An `add` peeks its PROPOSAL — there is no work item yet; anything else is an
  // ordinary committed node (a sibling, or a modify/remove's live target) and
  // gets the SHIPPED work-item peek, unchanged.
  //
  // ⚠️ A COMMITTED sibling now needs the id → identifier mapping every other
  // canvas consumer keeps (bug MOTIR-3152; `useWorkItemQuickView.registerItems`
  // is the shipped form of it). Before the fix a committed node carried no
  // `viewable` flag, so its View button never rendered and this handler only ever
  // saw a proposal. It renders now — and the peek is keyed by `MOTIR-<n>` while a
  // canvas node is keyed by its cuid, so without the mapping the newly reachable
  // affordance would ask for an id no work item has.
  const [peeked, setPeeked] = useState<{ proposal: PlanReviewItemDto | null; key: string | null }>({
    proposal: null,
    key: null,
  });
  const byNodeId = useMemo(() => new Map(items.map((i) => [i.nodeId, i])), [items]);
  // node id → its identifier, accumulated as levels load. A ref, not state: it is
  // a lookup the View handler reads, never something a render depends on.
  const identifierByIdRef = useRef(new Map<string, string>());
  const onView = useCallback(
    (nodeId: string) => {
      const proposal = byNodeId.get(nodeId);
      // An `add` peeks its PROPOSAL only while it still IS one. Once the plan is
      // approved that proposal HAS become a work item and carries its real
      // identifier (MOTIR-3160's keying), so peeking it as a proposal would open
      // the pre-approval view of a card that now exists — a label that lies about
      // what clicking it does. An `add` with an identifier is a committed card;
      // peek it as one (MOTIR-3161).
      if (proposal && proposal.op === 'add' && !proposal.identifier)
        setPeeked({ proposal, key: null });
      // A `modify` / `remove` names its live target itself; a committed sibling is
      // resolved from the level it arrived on. A node that is neither opens
      // nothing rather than a peek for a key no work item has.
      else
        setPeeked({
          proposal: null,
          key: proposal?.identifier ?? identifierByIdRef.current.get(nodeId) ?? null,
        });
    },
    [byNodeId],
  );
  const closePeek = useCallback(() => setPeeked({ proposal: null, key: null }), []);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // The COMMITTED level. A failure here must not blank the review — the plan
      // is the page's subject and the surrounding tree is context — so it degrades
      // to "just this plan's proposals at that level", which is what the surface
      // showed before this change. `fetchRoadmapLevel` is already best-effort and
      // resolves an empty level rather than throwing, so the degrade is its.
      let committed: RoadmapLevel = { nodes: [], deps: [] };
      // No project to read a level from — a pre-project discovery run
      // (`GenerationFlow`) proposes a tree before one exists, so there is no
      // committed neighbourhood and the proposals legitimately stand alone.
      if (projectKey) {
        const wi = await fetchRoadmapLevel(projectKey, parentId, 'project');
        for (const it of wi.items) identifierByIdRef.current.set(it.id, it.identifier);
        for (const b of wi.offLevelBlockers) identifierByIdRef.current.set(b.id, b.identifier);
        committed = buildWorkItemLevel(wi);
      }
      return mergePlanLevel(committed, items, parentId, outcome);
    },
    [items, projectKey, outcome],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        onView={onView}
        loadLevel={loadLevel}
        reloadKey={`${version}:${proposalsAtLevel(items, null).length}`}
        initialTrail={initialTrail}
        searchable
        // The root crumb goes where the ROADMAP's does — `parentId = null`, the
        // project's top level — so it is labelled the way the roadmap labels it
        // (bug MOTIR-3152). It used to read "Plan" while navigating to the project
        // roadmap root, which named a destination it did not have; and the design
        // asks for the breadcrumb *"exactly as the roadmap draws it"*, which is
        // this label, on this consumer, for the same reason `PlanChangeCanvas`
        // uses it.
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? 'Proposed plan'}
      />
      <ProposalQuickView item={peeked.proposal} onClose={closePeek} />
      <WorkItemQuickView peekKey={peeked.key} onClose={closePeek} />
    </>
  );
}
