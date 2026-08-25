import {
  PlanningOriginCluster,
  ORIGIN_H,
  ORIGIN_W,
} from '@/components/planning/PlanningOriginCluster';
import {
  GhostAnchor,
  LevelGroupNode,
  LevelTruncationTile,
  WorkItemNode,
} from '@/components/planning/WorkItemNode';
import {
  workItemCrumbLabel,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { DirectionDocKind } from '@/lib/onboarding/directionDoc';

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
// EXPORTED (MOTIR-2205) because the node is now a DOOR: `WorkItemRoadmap.loadLevel`
// intercepts this id and serves the synthetic pre-plan station level for it, so both
// halves of the drill must name the same id — never two literals.
export const ORIGIN_ID = '__planning_origin__';

// The id of the synthetic GROUPED node holding a root level's non-epic rows
// (MOTIR-3490). EXPORTED for the same reason `ORIGIN_ID` is: the node is a DOOR,
// and `WorkItemRoadmap.loadLevel` intercepts this id to serve what is behind it —
// so both halves of the drill must name the same id, never two literals.
export const NOT_IN_EPIC_ID = '__not_in_an_epic__';

// The id of the synthetic TRUNCATION tile (MOTIR-3490). Not a door — the consumer
// intercepts it on ACTIVATION, to re-read this level with the raised ceiling.
export const LEVEL_MORE_ID = '__level_more__';

/**
 * Does this row belong in the grouped node rather than on the road?
 *
 * BOTH conjuncts are load-bearing (design decision 6, `design/roadmap/design-notes.md`):
 *
 *  - `kind !== 'epic'` — the road IS the epics, and this is total over the four
 *    kinds a root may take (`prisma/sql/work_item_triggers.sql` refuses only
 *    `subtask` at the root). A `bug`-only test would leave a parentless `story` or
 *    `task` drawing on the road and re-open this defect the first time one is filed.
 *  - `parentId === null` — the one that stops it being destructive in SPRINT scope.
 *    There, `findProjectTreeLevel` re-roots the level at the topmost IN-SPRINT
 *    members, which are usually stories and subtasks: every one of them not an
 *    epic. Without this conjunct the sprint's actual work would collapse into a
 *    single node. A row that is a root of the sprint VIEW still has a parent, so
 *    it stays on the road; only a root of the TREE groups.
 */
export function isNotInEpicRow(item: { parentId: string | null; kind: string }): boolean {
  return item.parentId === null && item.kind !== 'epic';
}

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
   *
   * In `'sprint'` scope it ALSO drives the per-NODE "not in sprint" signal: a
   * drilled-in node whose `inActiveSprint` is false (a child of a committed root
   * that the sprint did not itself commit to) is rendered differently, so the
   * committed unit stays visually distinct from the rest of its subtree.
   */
  scope?: 'project' | 'sprint';
  /**
   * The planning-origin node's BREADCRUMB label (MOTIR-2205) — the crumb the canvas
   * shows once the phase card is drilled ("Planning"). Supplied by the consumer
   * because it is localized copy (`roadmap.canvas.origin.crumb`) and this builder is
   * a pure function with no translator of its own.
   */
  originCrumbLabel?: string;
  /**
   * The direction tiers the project's pre-plan journey PRODUCED (MOTIR-2205), or
   * `null` while the consumer's read is still in flight / failed. Drives the phase
   * card's honest badge (`PlanningOriginCluster`); `null` renders it chip-less, so
   * the level can be built — and painted — before the read lands.
   */
  originProduced?: readonly DirectionDocKind[] | null;
  /**
   * Group this level's NON-EPIC ROOT rows into one node (MOTIR-3490). Passed by the
   * roadmap consumer for the ROOT level only — a drilled level's rows are somebody's
   * children and belong exactly where they are. See {@link isNotInEpicRow}.
   */
  groupNonEpicRoots?: boolean;
  /** The grouped node's BREADCRUMB label — localized copy the consumer supplies,
   *  for the same reason `originCrumbLabel` is supplied rather than resolved here:
   *  this builder is a pure function with no translator of its own. */
  groupCrumbLabel?: string;
  /**
   * How many rows the level HAS, when the read reported it. Greater than the rows
   * actually returned ⇒ the level was truncated by the read's cap, and the
   * truncation tile is drawn (MOTIR-3490). Absent / equal ⇒ no tile, which is both
   * the ordinary case and the pre-MOTIR-3490 behaviour.
   */
  levelTotal?: number;
}

export function buildWorkItemLevel(
  wi: RoadmapLevelData,
  opts: BuildWorkItemLevelOptions = {},
): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const scope = opts.scope ?? 'project';
  // THE PARTITION (MOTIR-3490), computed BEFORE anything else reads the level,
  // because everything downstream depends on which rows are actually ON it.
  const grouped = opts.groupNonEpicRoots === true ? wi.items.filter(isNotInEpicRow) : [];
  const groupedIds = new Set(grouped.map((i) => i.id));
  const onLevel = grouped.length > 0 ? wi.items.filter((i) => !groupedIds.has(i.id)) : wi.items;

  const itemIds = new Set(onLevel.map((i) => i.id));
  const statusById = new Map(onLevel.map((i) => [i.id, i.status]));
  // A GROUPED row is OFF this level now, so an edge to it takes the off-level path
  // — and we have its whole row in hand, so it gets a proper naming stub instead of
  // an anonymous anchor. Dropping such an edge instead would have been the quiet
  // option and the wrong one: an epic blocked by a grouped defect is still blocked,
  // and the flag is how the reader finds out.
  const offById = new Map(wi.offLevelBlockers.map((b) => [b.id, b]));
  for (const g of grouped) {
    if (offById.has(g.id)) continue;
    offById.set(g.id, {
      id: g.id,
      identifier: g.identifier,
      title: g.title,
      parentTitle: null,
      isDone: g.status === 'done',
      inActiveSprint: g.inActiveSprint ?? false,
    });
  }

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
        // The off-level blocker is a REAL work item with a valid identifier
        // (MOTIR-1586) — make its ghost anchor VIEWABLE so "blocked by something
        // elsewhere" is peekable, exactly like any other work-item node: selecting
        // it shows the View button, and View opens the shared `WorkItemQuickView`
        // (which resolves the anchor id → its identifier via `registerItems`). A
        // bare click only SELECTS — no click-to-open, consistent with every card.
        viewable: true,
        content: (
          <GhostAnchor
            identifier={stub?.identifier ?? '—'}
            title={stub?.title}
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
    ? (onLevel.find((i) => i.status === 'in_progress')?.id ?? null)
    : null;

  const itemNodes: ProjectCanvasNode[] = onLevel.map((item) => {
    // NOT IN SPRINT (MOTIR-1379 follow-up): only meaningful in sprint scope. The
    // root level shows only in-sprint members, but drilling into a committed root
    // reveals its WHOLE subtree — so a child that the sprint did not commit to
    // reads as a NON-member here. Flag it so the node is shown differently ("not in
    // sprint"), keeping the committed unit visually distinct from the rest of its
    // subtree. Project scope never flags (no sprint resolved → `inActiveSprint`
    // false for all; the flag is gated on scope so it stays inert).
    const notInSprint = scope === 'sprint' && item.inActiveSprint === false;
    return {
      id: item.id,
      parentId: item.parentId,
      searchText: `${item.identifier} ${item.title}`,
      // `identifier · title`, not the bare key (MOTIR-1805 design DECISION 2). On a
      // MANUAL drill the key alone sufficed — the user had just read the card they
      // clicked. On an AUTO-DESCENDED ARRIVAL nobody clicked (MOTIR-1807), and the
      // breadcrumb is the ONLY thing carrying the skipped level, so a bare key would
      // reference it without naming it. Applied to manual and auto crumbs identically,
      // so no special mode is introduced. Shared with the trail the planning host
      // SEEDS the canvas with (MOTIR-2070) via one helper, so the two can't drift.
      crumbLabel: workItemCrumbLabel(item.identifier, item.title),
      drillable: item.hasChildren,
      // Every real work item offers the quick-view peek (MOTIR-1352). The ghost
      // anchors below are off-level blocker STUBS — they are ALSO viewable now
      // (MOTIR-1586), since each names a real, peekable work item; see the anchor
      // node above.
      viewable: true,
      // Surface the LOCATE targets (MOTIR-1421) onto the canvas node: the frontier
      // ("you are here") and the ready-to-start flag, so the canvas can centre on the
      // actionable node without knowing about work-item readiness itself.
      here: item.id === activeId,
      ready: item.ready ?? false,
      content: (
        <WorkItemNode
          item={{
            id: item.id,
            identifier: item.identifier,
            title: item.title,
            kind: item.kind,
            status: item.status,
            // The status's own LABEL + CATEGORY (bug MOTIR-3170) — without them
            // the chip can only name a default key out of the i18n catalog, and
            // every other status rendered as "To Do".
            statusLabel: item.statusLabel ?? null,
            statusCategory: item.statusCategory ?? null,
            type: item.type ?? null,
            executor: item.executor ?? null,
          }}
          drillable={item.hasChildren}
          crossBlocked={crossBlocked.has(item.id)}
          crossBlockedSprint={scope === 'sprint'}
          notInSprint={notInSprint}
          progress={item.progress ?? null}
          here={item.id === activeId}
          ready={item.ready ?? false}
        />
      ),
    };
  });

  // The planning-origin cluster (Subtask 7.20.6 / MOTIR-1013) — a FIXED-position
  // node pinned to the LEFT of the auto-laid epics so the road reads from its
  // completed-planning start. It carries an explicit position (so it's excluded
  // from the auto-layout) and NO dependency edge (the work items are the user's
  // own tree, not output the planning stations produced — the same reasoning the
  // onboarding init screen uses for its plan preview), so it never distorts the
  // epics' layout. Only at the ROOT level, and only when there ARE epics to anchor.
  const originNodes: ProjectCanvasNode[] =
    opts.includeOrigin && onLevel.length > 0
      ? [
          {
            id: ORIGIN_ID,
            parentId: null,
            // A DOOR, not a picture (MOTIR-2205): selecting the card surfaces the
            // canvas's shipped "Open ›" pill and drilling it lands on the pre-plan
            // STATION level (`buildPreplanStationLevel`, served by the consumer's
            // `loadLevel`) — the same drill path every epic beside it already uses.
            // It is deliberately NOT `viewable`: the card has no detail peek of its
            // own, because its detail IS the level below it.
            drillable: true,
            crumbLabel: opts.originCrumbLabel,
            // DECORATION, not a member of the level's work (MOTIR-1824). No real
            // work item backs it, and it is the level's provenance rather than
            // one of its branches — so the canvas's "does this level offer a
            // choice?" test (`autoDescendSingleParent`) must not count it. Left
            // uncounted, an ONBOARDED project's root level was never the
            // single-drillable-node shape and the auto-descend never fired for it.
            //
            // ⚠️ This SURVIVES the `drillable: true` above (MOTIR-2205): drillable
            // and decorative are independent axes. Giving the card a drill path must
            // not make it a branch, or an onboarded single-epic project stops
            // auto-descending exactly as it did before MOTIR-1824 was fixed.
            decorative: true,
            searchText: 'Planning origin idea discover shape validate plan',
            content: <PlanningOriginCluster produced={opts.originProduced ?? null} />,
            // Left of the auto-layout origin (x=40, y=40 in `deterministicLayout`),
            // vertically aligned with the first epic row.
            x: -(ORIGIN_W + 80),
            y: 40,
            width: ORIGIN_W,
            height: ORIGIN_H,
          },
        ]
      : [];

  // THE GROUPED NODE (MOTIR-3490) — emitted only when the partition caught
  // something, so the level it opens can never be empty and there is no empty
  // state to draw. It carries NO explicit position: `deterministicLayout` already
  // drops a node that takes part in no dependency edge into its own band BELOW the
  // flow ("Loose nodes ... e.g. a standalone bug"), which is exactly where this
  // belongs — unlike the pinned origin cluster, which overrides its own x/y.
  const groupNodes: ProjectCanvasNode[] =
    grouped.length > 0
      ? [
          {
            id: NOT_IN_EPIC_ID,
            parentId: null,
            // A DOOR: the consumer's `loadLevel` intercepts this id and serves the
            // grouped rows from the level it has ALREADY fetched.
            drillable: true,
            crumbLabel: opts.groupCrumbLabel,
            // NOT `viewable` — like the planning-origin card, its detail IS the
            // level below it; there is no work item to peek at.
            viewable: false,
            // NOT `decorative`, and this is the decision rather than an oversight
            // (design decision 5). `decorative` means "not a member of the level's
            // WORK", which is true of the origin cluster and false of this node: it
            // holds real work items, so it IS a branch, and the canvas's "does this
            // level offer a CHOICE?" test must count it. Marking it decorative would
            // auto-descend the reader PAST it into a lone epic, hiding the
            // unparented work on arrival — the silence this card exists to end.
            searchText: grouped.map((g) => `${g.identifier} ${g.title}`).join(' '),
            content: <LevelGroupNode count={grouped.length} />,
          },
        ]
      : [];

  // THE TRUNCATION TILE (MOTIR-3490) — the level read is capped, and this is the
  // only thing that says so. Compared against the rows the READ returned
  // (`wi.items`), never against the rows left after grouping: grouping moves rows,
  // the cap loses them, and reporting the one as the other would be a false claim.
  const total = opts.levelTotal;
  const moreNodes: ProjectCanvasNode[] =
    typeof total === 'number' && total > wi.items.length
      ? [
          {
            id: LEVEL_MORE_ID,
            parentId: null,
            // NOT a door — there is no level behind it, only more of this one.
            drillable: false,
            viewable: false,
            // DECORATIVE: it is an annotation ABOUT the level, not a branch in it,
            // so it must not turn a single-drillable-node level into a "choice" and
            // suppress the auto-descend.
            decorative: true,
            searchText: '',
            content: <LevelTruncationTile shown={wi.items.length} total={total} />,
          },
        ]
      : [];

  return {
    nodes: [...originNodes, ...itemNodes, ...groupNodes, ...anchorNodes, ...moreNodes],
    deps,
  };
}
