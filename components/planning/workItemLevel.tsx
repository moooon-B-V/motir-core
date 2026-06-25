import { GhostAnchor, WorkItemNode } from '@/components/planning/WorkItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';

// Turn one fetched roadmap LEVEL (items + blocked_by edges + off-level blocker
// stubs) into the canvas's nodes + deps (Subtask 7.20.2 / MOTIR-1194 + the 1331
// design). Shared by every work-item consumer (the roadmap view + onboarding):
//  - each item → a `WorkItemNode` (drillable from `hasChildren`);
//  - a within-level blocked_by edge → a firm/pending arrow (blocker done → firm);
//  - a blocker on ANOTHER level → the CROSS-STORY signal: a `cross` (red) edge to
//    a GHOST ANCHOR node that names the off-level blocker, and the blocked node is
//    flagged (red ring + "cross-story" pill).

export function buildWorkItemLevel(wi: RoadmapLevelData): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const itemIds = new Set(wi.items.map((i) => i.id));
  const statusById = new Map(wi.items.map((i) => [i.id, i.status]));
  const offById = new Map(wi.offLevelBlockers.map((b) => [b.id, b]));

  const crossBlocked = new Set<string>();
  const deps: ProjectCanvasDep[] = [];
  const anchorNodes: ProjectCanvasNode[] = [];
  const anchorAdded = new Set<string>();

  for (const e of wi.edges) {
    if (itemIds.has(e.blockerId)) {
      // within-level: a normal arrow (firm once the blocker is done).
      deps.push({
        from: e.blockerId,
        to: e.blockedId,
        variant: statusById.get(e.blockerId) === 'done' ? 'firm' : 'pending',
      });
    } else {
      // cross-story: a red edge to a ghost anchor naming the off-level blocker.
      crossBlocked.add(e.blockedId);
      deps.push({ from: e.blockerId, to: e.blockedId, variant: 'cross' });
      if (!anchorAdded.has(e.blockerId)) {
        anchorAdded.add(e.blockerId);
        const stub = offById.get(e.blockerId);
        anchorNodes.push({
          id: e.blockerId,
          parentId: null,
          drillable: false,
          searchText: stub ? `${stub.identifier} ${stub.title}` : e.blockerId,
          crumbLabel: stub?.identifier,
          content: (
            <GhostAnchor
              identifier={stub?.identifier ?? '—'}
              title={stub?.title ?? 'Blocked across stories'}
              parentTitle={stub?.parentTitle ?? null}
            />
          ),
        });
      }
    }
  }

  const itemNodes: ProjectCanvasNode[] = wi.items.map((item) => ({
    id: item.id,
    parentId: item.parentId,
    searchText: `${item.identifier} ${item.title}`,
    crumbLabel: item.identifier,
    drillable: item.hasChildren,
    content: (
      <WorkItemNode
        item={{
          id: item.id,
          identifier: item.identifier,
          title: item.title,
          kind: item.kind,
          status: item.status,
        }}
        drillable={item.hasChildren}
        crossBlocked={crossBlocked.has(item.id)}
      />
    ),
  }));

  return { nodes: [...itemNodes, ...anchorNodes], deps };
}
