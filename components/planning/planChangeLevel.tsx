import { PlanChangeDiffFrame, ProposedAddNode } from '@/components/planning/PlanChangeDiffNode';
import type { RoadmapLevel } from '@/components/planning/ProjectRoadmapCanvas';
import {
  diffStateForItem,
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

export interface PlanChangeLevelFocus {
  /** The canvas focus — null at the top level. */
  focusNodeId: string | null;
  /** The focus's work-item key, when it is a committed item (for `parentKey`
   *  placement of proposed children). Null at the top level. */
  focusKey: string | null;
}

export function decoratePlanChangeLevel(
  base: RoadmapLevel,
  wi: RoadmapLevelData,
  index: PlanChangeDiffIndex,
  focus: PlanChangeLevelFocus,
): RoadmapLevel {
  if (index.isEmpty) return base;

  const itemById = new Map(wi.items.map((i) => [i.id, i]));

  const nodes: ProjectCanvasNode[] = base.nodes.map((node) => {
    const item = itemById.get(node.id);
    if (!item) return node; // a ghost anchor / the planning-origin cluster
    const state = diffStateForItem(index, item);
    if (!state) return node;
    const op = state === 'change' ? index.updatesByKey.get(item.identifier) : undefined;
    return {
      ...node,
      // The state joins the node's search text so "changed" / "locked" is findable
      // with the canvas's own search-to-locate, not only visible.
      searchText: `${node.searchText} ${state}`,
      content: (
        <PlanChangeDiffFrame state={state} {...(op ? { op } : {})}>
          {node.content}
        </PlanChangeDiffFrame>
      ),
    };
  });

  const proposed: ProjectCanvasNode[] = proposedAddsForLevel(index, focus).map((add) => ({
    id: add.nodeId,
    parentId: focus.focusNodeId,
    searchText: `${add.op.fields.title} ${add.op.kind} proposed`,
    crumbLabel: add.op.fields.title,
    drillable: add.hasChildren,
    // A proposal has no work item to peek at yet — no View action.
    viewable: false,
    content: <ProposedAddNode add={add} />,
  }));

  return { nodes: [...nodes, ...proposed], deps: base.deps };
}
