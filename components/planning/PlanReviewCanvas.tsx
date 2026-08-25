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
import { fullestContainer } from '@/lib/planning/planShape';
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
 * Where to OPEN the canvas: the container the plan most FILLS, plus the ANCESTOR
 * PATH down to it (bug MOTIR-3152; MOTIR-3260).
 *
 * A plan whose proposals sit under several parents has no single level — that is
 * the drill-down model working, not a gap — so the arrival level is the one
 * carrying the most proposals, and the rail remains the whole-plan list. A plan
 * that proposes only roots (or whose parents were archived, which resolves to no
 * parent at all) opens at the top level, exactly as a genuine root should.
 *
 * ⚠️ A PROPOSED CONTAINER COUNTS, and it did not (MOTIR-3260). This function used
 * to skip any item without a `parentIdentifier` — and `getPlanReview` sets that
 * field to null for an intra-plan (`planItem:`) parent, deliberately, because
 * such a parent is drawn ON the canvas rather than in the breadcrumb. So the
 * count discarded exactly the items the null describes: a plan proposing one
 * story under a committed epic PLUS five subtasks under that story scored one
 * edge and opened on the EPIC, with the five cards it is actually about one
 * undiscoverable drill away. `parentNodeId` IS populated for those items, and the
 * counting now lives in `planShape.ts`, which `MOTIR-3262`'s derived default
 * reads too — one implementation of "how is this plan spread", not two.
 *
 * ⚠️ The trail is the WHOLE CHAIN, not one crumb. The design asks for *"the
 * committed ancestor path down to the focused level, exactly as the roadmap draws
 * it"* (`design/ai-planning/design-notes.md` Part V §2 panel E), and a chain has
 * to be CARRIED — `parentTrail` on the review model — rather than synthesised
 * from the immediate parent. An EMPTY trail beside a non-null parent means the
 * chain could not be resolved (an archived ancestor); that degrades to the single
 * crumb the parent fields still name, so the canvas never arrives with no
 * breadcrumb at all. When the arrival parent is itself a PROPOSAL there is no
 * committed chain on that item — the trail is its own `parentTrail` plus one
 * crumb for the proposal, walked up as far as the proposal chain goes.
 */
export function arrivalLevel(
  items: PlanReviewItemDto[],
  /**
   * The word a PROPOSED crumb puts where a key would go — `planReview.proposedCrumb`,
   * *"New"* in English (Part IX §1.3).
   *
   * Passed in rather than looked up, because this function is PURE and is unit-
   * tested directly. An un-materialized `add` has `identifier: null` **by
   * construction**, and a placeholder key (`MOTIR-?`, `#new-3`) would assert a
   * work item that does not exist — on the one surface whose whole promise is
   * that nothing is real until approve. So the crumb keeps the committed
   * `KEY · Title` grammar and substitutes the SLOT, which makes the distinction
   * TEXT rather than colour.
   */
  proposedWord: string,
): { id: string; trail: CanvasCrumb[] } | null {
  const container = fullestContainer(items);
  if (!container?.parentNodeId) return null;
  return {
    id: container.parentNodeId,
    trail: trailTo(items, container.parentNodeId, proposedWord),
  };
}

/**
 * The breadcrumb down to a container, committed or proposed.
 *
 * Walks UP from the container: each PROPOSED ancestor contributes one crumb
 * labelled `<proposedWord> · <title>`; the first COMMITTED one contributes the
 * `parentTrail` any item naming it carries, which is the whole committed chain.
 */
function trailTo(
  items: PlanReviewItemDto[],
  parentNodeId: string,
  proposedWord: string,
): CanvasCrumb[] {
  const byNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const proposed: CanvasCrumb[] = [];
  const seen = new Set<string>();

  let cursor: string | null = parentNodeId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const proposal: PlanReviewItemDto | undefined = byNodeId.get(cursor);
    if (!proposal) {
      // COMMITTED. Any item under it carries the committed chain down to it; an
      // EMPTY one is the archived-ancestor degrade, and the single crumb the
      // parent fields still name is what keeps the breadcrumb from vanishing.
      const namer = items.find((item) => item.parentNodeId === cursor);
      const carried =
        namer?.parentTrail.map((c) => ({
          id: c.id,
          label: workItemCrumbLabel(c.identifier, c.title),
        })) ?? [];
      const committed =
        carried.length > 0
          ? carried
          : namer?.parentIdentifier
            ? [
                {
                  id: cursor,
                  label: workItemCrumbLabel(namer.parentIdentifier, namer.parentTitle ?? ''),
                },
              ]
            : [];
      return [...committed, ...proposed];
    }
    proposed.unshift({
      id: proposal.nodeId,
      label: workItemCrumbLabel(proposedWord, proposal.title),
    });
    cursor = proposal.parentNodeId;
  }
  // The chain ran out inside the plan — every ancestor is a proposal. Whatever
  // committed trail the topmost one carries goes in front of them.
  const top = byNodeId.get(parentNodeId);
  const carried =
    top?.parentTrail.map((c) => ({
      id: c.id,
      label: workItemCrumbLabel(c.identifier, c.title),
    })) ?? [];
  return [...carried, ...proposed];
}

export function PlanReviewCanvas({
  items,
  projectKey,
  version,
  outcome = null,
  ariaLabel,
}: PlanReviewCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const tPlan = useTranslations('planReview');
  // A DECIDED plan keeps the control, in the PAST tense (Part IX §L7): *"what did
  // this plan change?"* is a better question after approve than before — the
  // cards are real now and sit among neighbours that were always there. A
  // DECLINED plan reads the same, because the record is of what the plan WOULD
  // have changed and the reader is asking the same thing.
  const decided = outcome !== null;
  const arrival = useMemo(() => arrivalLevel(items, tPlan('proposedCrumb')), [items, tPlan]);
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

  // ── The plan's node ids CHANGE at approve, and the canvas is holding them ────
  //
  // `materialize` re-keys every `add` to the work item it became — the review
  // model's one keying rule, `nodeId: item.workItemId ?? item.id` (MOTIR-3160) —
  // and resolves each intra-plan `planItem:` ref through the same map, so a
  // proposed container's children re-parent onto its new cuid too. Nothing about
  // that is wrong; what was missing is that a MOUNTED canvas is holding the old
  // id as its drilled focus and in its breadcrumb, and `PlanDetail`'s approve is
  // a re-render (a refetch + a version bump), not a remount. The reviewer
  // standing on a proposed container therefore watched their level go empty —
  // "No items at this level" — at the exact moment the rail said the plan was
  // approved (bug MOTIR-3439).
  //
  // The OLD id of a materialized `add` is precisely its `planItemId`, which is
  // the one field that never moves. So the map needs no memory of the previous
  // render: `planItemId → what that node is now` answers the canvas's question
  // from the CURRENT items alone.
  //
  // Only an `add` appears. A pending one is skipped because its `nodeId` IS its
  // `planItemId` (mapping it would be a no-op, and the resolver has to be
  // idempotent); a `modify` / `remove` is skipped because its `planItemId` is
  // never a canvas node id — its node is the committed card it targets, which
  // the canvas has held under that id all along.
  const heldNodeByPlanItemId = useMemo(() => {
    const byPlanItemId = new Map<string, CanvasCrumb>();
    for (const item of items) {
      if (item.op !== 'add' || item.nodeId === item.planItemId) continue;
      byPlanItemId.set(item.planItemId, {
        id: item.nodeId,
        // The crumb keeps the committed `KEY · Title` grammar. `New` stands in
        // the key's slot only while there is no key to put there — a
        // placeholder would assert a work item that does not exist
        // (`design/ai-planning/design-notes.md` Part IX §1.3) — and once the
        // card is real, saying `New` is the lie the substitution existed to
        // avoid. Same rule the View door already follows: an `add` carrying an
        // identifier is a committed card (MOTIR-3161).
        label: workItemCrumbLabel(item.identifier ?? tPlan('proposedCrumb'), item.title),
      });
    }
    return byPlanItemId;
  }, [items, tPlan]);
  const resolveHeldNode = useCallback(
    (id: string) => heldNodeByPlanItemId.get(id) ?? null,
    [heldNodeByPlanItemId],
  );

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
        // The level the reviewer is standing on FOLLOWS its container through
        // approve, rather than being left addressed by an id that has stopped
        // naming anything (bug MOTIR-3439).
        resolveHeldNode={resolveHeldNode}
        searchable
        // SHOW CHANGES (MOTIR-3261) — the set is EVERY proposal's node id,
        // whatever its `op`, which is what the request's *added / updated /
        // archived* names. A `modify` / `remove` shares its node id with the
        // committed card it targets, so the ring lands ON that card rather than
        // beside it — already how `mergePlanLevel` re-skins them, which is why
        // the emphasis needs no per-op special case.
        //
        // The op languages stay exactly as panel B draws them: they say WHICH
        // change this is, the emphasis says THAT there is one. Orthogonal, and
        // neither an alternative to the other.
        //
        // The COPY comes from here rather than the foundation, which has no idea
        // it is showing a plan and cannot name what "the plan's changes" are.
        emphasis={{
          ids: items.map((i) => i.nodeId),
          total: items.length,
          label: decided ? tPlan('showChangesPast') : t('showChanges'),
          emptyLabel: t('showChangesNone'),
        }}
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
