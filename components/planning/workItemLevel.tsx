import {
  PlanningOriginCluster,
  ORIGIN_H,
  ORIGIN_W,
} from '@/components/planning/PlanningOriginCluster';
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
//
// Subtask 7.20.6 / MOTIR-1013 adds (via `opts`, used by the persistent roadmap —
// NOT onboarding):
//  - `markActive` — the in-progress FRONTIER node (the active epic at the road's
//    start) is marked "you are here";
//  - `includeOrigin` — at the ROOT level, the collapsed planning-origin cluster is
//    pinned LEFT of the epics so the road reads from its completed-planning start.
//  - each container item carries its subtree `progress` meter.

// The id of the synthetic planning-origin node (no real work item backs it).
const ORIGIN_ID = '__planning_origin__';

export interface BuildWorkItemLevelOptions {
  /** Mark the in-progress frontier node "you are here" (the roadmap consumer). */
  markActive?: boolean;
  /** Pin the planning-origin cluster at the road's start (the ROOT level only). */
  includeOrigin?: boolean;
  /**
   * The roadmap SCOPE (MOTIR-1379). In `'project'` scope every off-level blocker is
   * the CROSS-STORY tangle (a bad plan). In `'sprint'` scope the same edges become a
   * SPRINT-VALIDITY signal: a blocker that is DONE or itself IN the active sprint is
   * satisfied (not drawn), and only an out-of-sprint, NOT-done blocker is flagged —
   * as "not in sprint", never "cross-story" (two items in the same story can still be
   * an out-of-sprint dependency). Defaults to `'project'`.
   */
  scope?: 'project' | 'sprint';
}

export function buildWorkItemLevel(
  wi: RoadmapLevelData,
  opts: BuildWorkItemLevelOptions = {},
): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const scope = opts.scope ?? 'project';
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
      continue;
    }
    const stub = offById.get(e.blockerId);
    // SPRINT scope: the off-level signal is sprint VALIDITY, not "cross-story". A
    // blocker that is DONE or itself IN the active sprint is satisfied → no signal
    // (the dependency is not drawn). Only an out-of-sprint, NOT-done blocker is the
    // problem. PROJECT scope: every off-level blocker is the cross-story tangle.
    if (scope === 'sprint' && (!stub || stub.isDone || stub.inActiveSprint)) {
      continue;
    }
    // a red edge to a ghost anchor naming the off-level blocker.
    crossBlocked.add(e.blockedId);
    deps.push({ from: e.blockerId, to: e.blockedId, variant: 'cross' });
    if (!anchorAdded.has(e.blockerId)) {
      anchorAdded.add(e.blockerId);
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
            outOfSprint={scope === 'sprint'}
          />
        ),
      });
    }
  }

  // The current-position ("you are here") node = the FIRST in-progress item on
  // this level, in the level's key-asc order (at the root that's the active epic).
  // None in progress → no marker.
  const activeId = opts.markActive
    ? (wi.items.find((i) => i.status === 'in_progress')?.id ?? null)
    : null;

  const itemNodes: ProjectCanvasNode[] = wi.items.map((item) => ({
    id: item.id,
    parentId: item.parentId,
    searchText: `${item.identifier} ${item.title}`,
    crumbLabel: item.identifier,
    drillable: item.hasChildren,
    // Every real work item offers the quick-view peek (MOTIR-1352). The ghost
    // anchors below are off-level blocker STUBS, not items on this level, so they
    // stay non-viewable (no `viewable` flag) — selecting one shows no View button.
    viewable: true,
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
        crossBlockedLabel={scope === 'sprint' ? 'not in sprint' : 'cross-story'}
        progress={item.progress ?? null}
        here={item.id === activeId}
        ready={item.ready ?? false}
      />
    ),
  }));

  // The planning-origin cluster (Subtask 7.20.6 / MOTIR-1013) — a FIXED-position
  // node pinned to the LEFT of the auto-laid epics so the road reads from its
  // completed-planning start. It carries an explicit position (so it's excluded
  // from the auto-layout) and NO dependency edge (the work items are the user's
  // own tree, not output the planning stations produced — the same reasoning the
  // onboarding init screen uses for its plan preview), so it never distorts the
  // epics' layout. Only at the ROOT level, and only when there ARE epics to anchor.
  const originNodes: ProjectCanvasNode[] =
    opts.includeOrigin && wi.items.length > 0
      ? [
          {
            id: ORIGIN_ID,
            parentId: null,
            drillable: false,
            searchText: 'Planning origin idea discover shape validate plan',
            content: <PlanningOriginCluster />,
            // Left of the auto-layout origin (x=40, y=40 in `deterministicLayout`),
            // vertically aligned with the first epic row.
            x: -(ORIGIN_W + 80),
            y: 40,
            width: ORIGIN_W,
            height: ORIGIN_H,
          },
        ]
      : [];

  return { nodes: [...originNodes, ...itemNodes, ...anchorNodes], deps };
}
