import { PlanChangeDiffFrame, ProposedAddNode } from '@/components/planning/PlanChangeDiffNode';
import type { RoadmapLevel } from '@/components/planning/ProjectRoadmapCanvas';
import {
  diffStateForItem,
  proposalForItem,
  proposedAddsForLevel,
  type PlanChangeDiffIndex,
} from '@/lib/planning/planChangeDiff';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';

// Layer a pending plan-change proposal onto ONE already-built roadmap level
// (Subtask MOTIR-1730). The level itself is the shipped work-item level
// (`buildWorkItemLevel` over the per-level read, MOTIR-1010/1194) — this only
// DECORATES it: an item the proposal changes gets the change frame, a finished
// item gets the lock, and the proposed items that belong on this level are
// appended as their own nodes.
//
// Pure (no fetching, no effects) so the placement rules are unit-testable; the
// consumer (`PlanChangeCanvas`) does the fetching and hands the result over.

export function decoratePlanChangeLevel(
  base: RoadmapLevel,
  wi: RoadmapLevelData,
  index: PlanChangeDiffIndex,
  /** The canvas focus — null at the top level. For a committed item it is that
   *  item's id, which is exactly what a proposal parented on it carries, so
   *  placement needs no second key. */
  focusNodeId: string | null,
): RoadmapLevel {
  if (index.isEmpty) return base;

  const itemById = new Map(wi.items.map((i) => [i.id, i]));
  // Which items on this level have a proposal hanging under them. A childless
  // item that the run proposes a child for MUST become drillable, or the proposal
  // is unreachable — and "propose work under an existing story" is the commonest
  // thing the engine does.
  const gainsChildren = new Set(
    index.adds.map((add) => add.parentNodeId).filter((id): id is string => id !== null),
  );

  const nodes: ProjectCanvasNode[] = base.nodes.map((node) => {
    const item = itemById.get(node.id);
    if (!item) return node; // a ghost anchor / the planning-origin cluster
    const state = diffStateForItem(index, item);
    const gainsChild = gainsChildren.has(node.id);
    if (!state) return gainsChild ? { ...node, drillable: true } : node;
    const proposal = state === 'locked' ? undefined : proposalForItem(index, item.id);
    return {
      ...node,
      drillable: node.drillable || gainsChild,
      // The state joins the node's search text so "changed" / "removed" / "locked"
      // is findable with the canvas's own search-to-locate, not only visible.
      searchText: `${node.searchText} ${state}`,
      content: (
        <PlanChangeDiffFrame state={state} {...(proposal ? { proposal } : {})}>
          {node.content}
        </PlanChangeDiffFrame>
      ),
    };
  });

  const proposed: ProjectCanvasNode[] = proposedAddsForLevel(index, focusNodeId).map((add) => ({
    id: add.nodeId,
    parentId: focusNodeId,
    searchText: `${add.item.title} ${add.item.kind} proposed`,
    crumbLabel: add.item.title,
    drillable: add.hasChildren,
    // A proposal has no work item to peek at yet — no View action.
    viewable: false,
    content: <ProposedAddNode add={add} />,
  }));

  return { nodes: [...nodes, ...proposed], deps: base.deps };
}
