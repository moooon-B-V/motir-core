// The WORK-ITEM canvas model (Subtask 7.20.2 / MOTIR-1194) — the pure data layer
// behind the reusable `WorkItemCanvas`. It turns a work-item FOREST (epics →
// stories → subtasks) + its `blocked_by` dependency edges into one navigable
// LEVEL at a time (the drill-down model, design `design/roadmap/*` sheet 6): the
// nodes visible at the current focus, their same-level dependency edges classified
// (within-story arrow vs the cross-story bad-plan SIGNAL), and a DETERMINISTIC
// auto-layout for those nodes.
//
// Kept free of React/DOM so it is exhaustively unit-testable; `WorkItemCanvas`
// composes it over the shipped `PlanningCanvas` engine. The component owns no
// fetching — the forest + edges arrive as DATA (the roadmap read / workspace
// state).

export type WorkItemCanvasKind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

export type WorkItemCanvasStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/** One work item as the canvas needs it — the presentational projection. */
export interface WorkItemCanvasItem {
  id: string;
  /** The human key, e.g. `MOTIR-1194`. */
  identifier: string;
  title: string;
  kind: WorkItemCanvasKind;
  status: WorkItemCanvasStatus;
  /** The PARENT item's id, or null for a forest root. */
  parentId: string | null;
  assigneeName?: string | null;
}

/** A `blocked_by` dependency: `blockedId` cannot start until `blockerId` is done. */
export interface WorkItemCanvasDep {
  blockedId: string;
  blockerId: string;
}

export type CanvasEdgeVariant = 'firm' | 'pending' | 'cross';

export interface CanvasLevelNode {
  item: WorkItemCanvasItem;
  /** Has children → clicking it DRILLS in (the drill-down model). */
  drillable: boolean;
}

export interface CanvasLevelEdge {
  /** The blocker (laid out / drawn first). */
  from: string;
  /** The blocked item. */
  to: string;
  variant: CanvasEdgeVariant;
}

export interface CanvasLevel {
  nodes: CanvasLevelNode[];
  edges: CanvasLevelEdge[];
}

/** One breadcrumb crumb on the drill path (root → … → focus). */
export interface CanvasCrumb {
  id: string;
  identifier: string;
  title: string;
}

// ── layout constants (exported so the component can hint node sizes for edge
//    anchoring + measure the deterministic grid). A node card is ~280×132. ──
export const NODE_W = 280;
export const NODE_H = 132;
const GAP_X = 80;
const GAP_Y = 72;
const COLS = 3;
const ORIGIN = 40;

function indexItems(items: WorkItemCanvasItem[]): Map<string, WorkItemCanvasItem> {
  return new Map(items.map((i) => [i.id, i]));
}

/** True when `item` is a forest ROOT — no parent, or a parent outside this set
 *  (so a partial subtree renders with its top items as roots). */
function isRoot(item: WorkItemCanvasItem, byId: Map<string, WorkItemCanvasItem>): boolean {
  return item.parentId === null || !byId.has(item.parentId);
}

/** The items visible at `focusId` (null → the forest roots; else focus's children). */
export function childrenOf(
  items: WorkItemCanvasItem[],
  focusId: string | null,
  byId: Map<string, WorkItemCanvasItem> = indexItems(items),
): WorkItemCanvasItem[] {
  if (focusId === null) return items.filter((i) => isRoot(i, byId));
  return items.filter((i) => i.parentId === focusId);
}

export function hasChildren(items: WorkItemCanvasItem[], id: string): boolean {
  return items.some((i) => i.parentId === id);
}

/**
 * The drill level a target item lives ON — the focus that makes it a visible
 * child. A root (no in-set parent) lives at the top level (`null`); otherwise it
 * is a child of its parent. Used by search-to-focus to navigate to the match.
 */
export function levelOf(items: WorkItemCanvasItem[], id: string): string | null {
  const byId = indexItems(items);
  const it = byId.get(id);
  if (!it || isRoot(it, byId)) return null;
  return it.parentId;
}

/** The breadcrumb path (root ancestor → focus, inclusive). Empty at the top. */
export function breadcrumb(items: WorkItemCanvasItem[], focusId: string | null): CanvasCrumb[] {
  if (focusId === null) return [];
  const byId = indexItems(items);
  const path: CanvasCrumb[] = [];
  let cur: WorkItemCanvasItem | undefined = byId.get(focusId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift({ id: cur.id, identifier: cur.identifier, title: cur.title });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/**
 * The visible LEVEL at `focusId`: the focus's children (or the roots) as nodes,
 * plus the `blocked_by` edges BETWEEN two visible nodes, each classified:
 *  - **cross** — the two ends sit under DIFFERENT parents (a story/parent-boundary
 *    crossing): the bad-plan signal (a correct plan is a tree).
 *  - **firm** — same parent and the blocker is `done` (a settled dependency).
 *  - **pending** — same parent, blocker not yet done.
 * An edge with an end outside the level is dropped (drill-down shows one level).
 */
export function computeLevel(
  items: WorkItemCanvasItem[],
  deps: WorkItemCanvasDep[],
  focusId: string | null,
): CanvasLevel {
  const byId = indexItems(items);
  const childParent = new Map<string, boolean>();
  for (const i of items) {
    if (i.parentId !== null) childParent.set(i.parentId, true);
  }
  const visible = childrenOf(items, focusId, byId);
  const visIds = new Set(visible.map((i) => i.id));

  const nodes: CanvasLevelNode[] = visible.map((item) => ({
    item,
    drillable: childParent.has(item.id),
  }));

  const edges: CanvasLevelEdge[] = [];
  for (const d of deps) {
    if (!visIds.has(d.blockedId) || !visIds.has(d.blockerId)) continue;
    if (d.blockedId === d.blockerId) continue;
    const blocked = byId.get(d.blockedId)!;
    const blocker = byId.get(d.blockerId)!;
    const cross = blocked.parentId !== blocker.parentId;
    const variant: CanvasEdgeVariant = cross
      ? 'cross'
      : blocker.status === 'done'
        ? 'firm'
        : 'pending';
    edges.push({ from: d.blockerId, to: d.blockedId, variant });
  }
  return { nodes, edges };
}

/**
 * A DETERMINISTIC auto-layout for the level's nodes: order them by the dependency
 * chain (blocker before blocked, stable Kahn topological sort; ties + any cycle
 * fall back to input order), then place left→right in a SERPENTINE grid (rows of
 * `COLS`, alternate rows reversed) so a chain reads as a flowing road and a large
 * level still fits the canvas width. Same input → same positions (no `Math.random`,
 * no `Date.now`): a saved position (per-user persistence) overrides per node.
 */
export function deterministicLayout(
  nodeIds: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): Record<string, { x: number; y: number }> {
  const order = topologicalOrder(nodeIds, edges);
  const pos: Record<string, { x: number; y: number }> = {};
  order.forEach((id, i) => {
    const row = Math.floor(i / COLS);
    const within = i % COLS;
    const col = row % 2 === 1 ? COLS - 1 - within : within;
    pos[id] = {
      x: ORIGIN + col * (NODE_W + GAP_X),
      y: ORIGIN + row * (NODE_H + GAP_Y),
    };
  });
  return pos;
}

/** Stable Kahn topological order; cycles/leftovers appended in input order. */
export function topologicalOrder(
  nodeIds: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  const idSet = new Set(nodeIds);
  const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  // Seed the queue in input order, and always pull the earliest-eligible node, so
  // the result is fully determined by input order (a plain array as a stable queue).
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) <= 0 && !seen.has(next)) queue.push(next);
    }
  }
  for (const id of nodeIds) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * Ids of items matching a free-text `query` (case-insensitive substring on the
 * identifier or title), in input order. A blank query matches nothing (search is
 * a locate action, not a filter that empties the canvas).
 */
export function searchMatches(items: WorkItemCanvasItem[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  return items
    .filter((i) => i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))
    .map((i) => i.id);
}

export const STATUS_LABELS: Record<WorkItemCanvasStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};
