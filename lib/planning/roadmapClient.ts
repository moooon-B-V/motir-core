import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemStatus } from '@/components/planning/WorkItemNode';

// Client read of ONE LEVEL of the project roadmap (Subtask 7.20.2 / MOTIR-1194)
// from the per-level endpoint (`GET /api/projects/[key]/roadmap?parentId=`,
// MOTIR-1010). The canvas fetches the roots, then a node's children on drill — so
// this is one request per level, never a whole-tree load (mistake #91). BEST-
// EFFORT, mirroring `useCanvasLayout`: a failed / absent read resolves to an empty
// level so the canvas degrades to just its stations and never blocks.

export interface RoadmapLevelItem {
  id: string;
  parentId: string | null;
  identifier: string;
  title: string;
  kind: IssueType;
  status: WorkItemStatus;
  /** Has children → the canvas can DRILL into it. */
  hasChildren: boolean;
}

export interface RoadmapEdge {
  blockedId: string;
  blockerId: string;
}

export interface RoadmapLevelData {
  items: RoadmapLevelItem[];
  edges: RoadmapEdge[];
}

/** The per-level node shape `GET …/roadmap?parentId=` returns (RoadmapNodeDto). */
interface RoadmapNode {
  id: string;
  parentId: string | null;
  kind: string;
  identifier: string;
  title: string;
  status: string;
  isDone: boolean;
  hasChildren: boolean;
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

function toItem(n: RoadmapNode): RoadmapLevelItem {
  return {
    id: n.id,
    parentId: n.parentId,
    identifier: n.identifier,
    title: n.title,
    kind: KNOWN_KINDS.has(n.kind as IssueType) ? (n.kind as IssueType) : 'subtask',
    status: toStatus(n.status, n.isDone),
    hasChildren: n.hasChildren,
  };
}

/**
 * Fetch one level of the project roadmap: the roots when `parentId` is null, else
 * that parent's direct children — plus the `is_blocked_by` edges from the level.
 * Best-effort: any failure resolves to an empty level.
 */
export async function fetchRoadmapLevel(
  projectKey: string,
  parentId: string | null,
  signal?: AbortSignal,
): Promise<RoadmapLevelData> {
  const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/roadmap${qs}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return { items: [], edges: [] };
    const body = (await res.json()) as { nodes?: RoadmapNode[]; edges?: RoadmapEdge[] };
    return { items: (body.nodes ?? []).map(toItem), edges: body.edges ?? [] };
  } catch {
    return { items: [], edges: [] };
  }
}
