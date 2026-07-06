import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemStatus } from '@/components/planning/WorkItemNode';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';

// Client read of ONE LEVEL of the project roadmap (Subtask 7.20.2 / MOTIR-1194)
// from the per-level endpoint (`GET /api/projects/[key]/roadmap?parentId=`,
// MOTIR-1010). The canvas fetches the roots, then a node's children on drill — so
// this is one request per level, never a whole-tree load (mistake #91). BEST-
// EFFORT, mirroring `useCanvasLayout`: a failed / absent read resolves to an empty
// level so the canvas degrades to just its stations and never blocks.

/** A container node's subtree done/total roll-up (Subtask 7.20.6 / MOTIR-1013) —
 *  the data behind the per-epic/story progress meter. `null` on a leaf. */
export interface RoadmapProgress {
  done: number;
  total: number;
}

export interface RoadmapLevelItem {
  id: string;
  parentId: string | null;
  identifier: string;
  title: string;
  kind: IssueType;
  status: WorkItemStatus;
  /** The leaf's work TYPE (Story 2.7) — `code` / `design` / `manual` / … or `null`
   *  on a container / untyped leaf. Together with {@link RoadmapLevelItem.executor}
   *  it drives the manual/human node chip (MOTIR-1642 / 8.8.36). Optional
   *  client-side: an older / onboarding read that omits it degrades to "no chip". */
  type?: WorkItemTypeDto | null;
  /** WHO executes the leaf (Story 2.7) — `coding_agent` / `human` / `null`. Paired
   *  with `type` for the `isManualReadyItem` predicate. Optional client-side. */
  executor?: ExecutorDto | null;
  /** Has children → the canvas can DRILL into it. */
  hasChildren: boolean;
  /** Subtree progress roll-up — present on container nodes, `null` on leaves
   *  (Subtask 7.20.6 / MOTIR-1013). Optional client-side: an older / onboarding
   *  read that omits it degrades to "no meter". */
  progress?: RoadmapProgress | null;
  /** READY to start (MOTIR-1417): a startable, fully-unblocked node → the ready
   *  highlight. Optional client-side: a read that omits it degrades to "no
   *  highlight". */
  ready?: boolean;
  /** Member of the ACTIVE sprint (MOTIR-1379 follow-up). Only meaningful in
   *  sprint scope: a drilled-in node whose `inActiveSprint` is false is part of a
   *  committed root's subtree but was NOT itself committed to the sprint → the
   *  "not in sprint" node treatment. Optional client-side: an older / project-scope
   *  read that omits it degrades to "in sprint" (no signal). */
  inActiveSprint?: boolean;
}

export interface RoadmapEdge {
  blockedId: string;
  blockerId: string;
}

/** A naming stub for a blocker that lives on ANOTHER level (the off-level anchor). */
export interface RoadmapBlockerStub {
  id: string;
  identifier: string;
  title: string;
  parentTitle: string | null;
  /** Blocker is in a terminal (done) status → a SATISFIED dependency (MOTIR-1379). */
  isDone?: boolean;
  /** Blocker is a member of the active sprint → an in-sprint dependency, not an
   *  out-of-sprint one. Only meaningful in sprint scope (false in project scope). */
  inActiveSprint?: boolean;
}

export interface RoadmapLevelData {
  items: RoadmapLevelItem[];
  edges: RoadmapEdge[];
  offLevelBlockers: RoadmapBlockerStub[];
}

/** The per-level node shape `GET …/roadmap?parentId=` returns (RoadmapNodeDto). */
interface RoadmapNode {
  id: string;
  parentId: string | null;
  kind: string;
  type?: string | null;
  executor?: string | null;
  identifier: string;
  title: string;
  status: string;
  isDone: boolean;
  hasChildren: boolean;
  progress?: { done: number; total: number } | null;
  ready?: boolean;
  inActiveSprint?: boolean;
}

const KNOWN_STATUSES: WorkItemStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

/** Map a roadmap status string to a canvas status; fall back via `isDone`. */
function toStatus(raw: string, isDone: boolean): WorkItemStatus {
  const s = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if ((KNOWN_STATUSES as string[]).includes(s)) return s as WorkItemStatus;
  return isDone ? 'done' : 'todo';
}

const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

// The ten work-item TYPE members (Story 2.7 · the 2.7.2 taxonomy ADR). Used to
// guard the raw wire value the SAME way `KNOWN_KINDS` guards `kind`: an
// unrecognised / absent `type` degrades to `null` (no chip) rather than crashing
// the best-effort level read (MOTIR-1642 / 8.8.36).
const KNOWN_TYPES = new Set<WorkItemTypeDto>([
  'code',
  'design',
  'test',
  'content',
  'research',
  'review',
  'decision',
  'deploy',
  'manual',
  'chore',
]);

/** Map one raw `RoadmapNode` wire row to a `RoadmapLevelItem` — exported for the
 *  unit test (the fallback behaviour matters and is otherwise internal). */
export function toItem(n: RoadmapNode): RoadmapLevelItem {
  return {
    id: n.id,
    parentId: n.parentId,
    identifier: n.identifier,
    title: n.title,
    kind: KNOWN_KINDS.has(n.kind as IssueType) ? (n.kind as IssueType) : 'subtask',
    type: KNOWN_TYPES.has(n.type as WorkItemTypeDto) ? (n.type as WorkItemTypeDto) : null,
    executor: n.executor === 'human' || n.executor === 'coding_agent' ? n.executor : null,
    status: toStatus(n.status, n.isDone),
    hasChildren: n.hasChildren,
    progress: n.progress ?? null,
    ready: n.ready ?? false,
    inActiveSprint: n.inActiveSprint ?? false,
  };
}

/** The roadmap SCOPE (MOTIR-1382): the whole project (default) or the active
 *  sprint's member-or-ancestor slice (`&scope=sprint`, MOTIR-1381). */
export type RoadmapScope = 'project' | 'sprint';

/**
 * Fetch one level of the project roadmap: the roots when `parentId` is null, else
 * that parent's direct children — plus the `is_blocked_by` edges from the level.
 * `scope='sprint'` narrows every level to the active sprint (no active sprint →
 * an empty level). Best-effort: any failure resolves to an empty level.
 */
export async function fetchRoadmapLevel(
  projectKey: string,
  parentId: string | null,
  scope: RoadmapScope = 'project',
  signal?: AbortSignal,
): Promise<RoadmapLevelData> {
  const params = new URLSearchParams();
  if (parentId) params.set('parentId', parentId);
  if (scope === 'sprint') params.set('scope', 'sprint');
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/roadmap${qs}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return { items: [], edges: [], offLevelBlockers: [] };
    const body = (await res.json()) as {
      nodes?: RoadmapNode[];
      edges?: RoadmapEdge[];
      offLevelBlockers?: RoadmapBlockerStub[];
    };
    return {
      items: (body.nodes ?? []).map(toItem),
      edges: body.edges ?? [],
      offLevelBlockers: body.offLevelBlockers ?? [],
    };
  } catch {
    return { items: [], edges: [], offLevelBlockers: [] };
  }
}
