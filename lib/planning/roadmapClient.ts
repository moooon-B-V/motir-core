import type { IssueType } from '@/lib/issues/parentRules';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';

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
  /** The workflow status KEY, verbatim (bug MOTIR-3170) — NOT narrowed to a
   *  closed set. The wire carries whatever the project's workflow defines, and a
   *  hand-copied six-member literal here coerced everything else to `todo`, so
   *  `implemented` / `planning` and every custom status drew as "To Do". Any
   *  treatment for it is resolved at render time from `canvasStatusMeta`, which
   *  falls back by CATEGORY and then to a neutral chip. */
  status: string;
  /** The status's own display LABEL, from the project's workflow. Optional
   *  client-side: an older / onboarding read that omits it degrades to the
   *  translated catalog label for a default key, else the raw key. */
  statusLabel?: string | null;
  /** The status's lifecycle CATEGORY — the chip's fallback tone for a key the
   *  canvas has no treatment for. Optional client-side (see `statusLabel`). */
  statusCategory?: StatusCategoryDto | null;
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
  statusLabel?: string | null;
  statusCategory?: string | null;
  isDone: boolean;
  hasChildren: boolean;
  progress?: { done: number; total: number } | null;
  ready?: boolean;
  inActiveSprint?: boolean;
}

// The hand-copied STATUS literal that used to stand here is GONE (bug
// MOTIR-3170). It listed
// exactly `todo · in_progress · in_review · blocked · done · cancelled` and
// coerced everything else to `isDone ? 'done' : 'todo'` — so `implemented`
// (MOTIR-3003) and `planning` (MOTIR-2425), both `in_progress`-category and both
// added to the default workflow long after this file was written, arrived here as
// **`todo`** and the canvas told the reader a card with an open pull request had
// not been started. Every project-defined custom status did the same.
//
// This is the identical move `KNOWN_TYPES` below already made for the TYPE enum
// (MOTIR-2632), whose comment describes this exact hazard and was written three
// declarations under the status literal it did not sweep. The set of statuses is
// DATABASE-defined and cannot be enumerated here at all, so the wire key passes
// through verbatim and the RENDERER resolves a treatment for it —
// `lib/workflows/canvasStatusMeta.ts`, key-first, category-second, neutral-last.

const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

// The lifecycle CATEGORY is a frozen three-member taxonomy (`StatusCategoryDto`),
// not a project-extensible set — so unlike the status KEY it IS guardable here,
// and an unrecognised wire value degrades to `null` (the neutral chip) the same
// way `kind` / `type` degrade. This is a totality guard on a closed enum, which is
// the opposite of the open-set literal removed above.
const KNOWN_STATUS_CATEGORIES: ReadonlySet<StatusCategoryDto> = new Set([
  'todo',
  'in_progress',
  'done',
]);

// The work-item TYPE members (Story 2.7 · the 2.7.2 taxonomy ADR). Used to
// guard the raw wire value the SAME way `KNOWN_KINDS` guards `kind`: an
// unrecognised / absent `type` degrades to `null` (no chip) rather than crashing
// the best-effort level read (MOTIR-1642 / 8.8.36).
//
// READ from `WORK_ITEM_TYPES` rather than re-stated (MOTIR-2632). This was a
// hand-copied ten-member literal, and a `Set` literal is not total-checked the
// way `Record<WorkItemTypeDto, …>` is — so when Amendment 1 admitted four
// members the compiler had nothing to say, and every roadmap node carrying one
// would have silently degraded to "no chip". That is the same silent-drop the
// story this change belongs to exists to fix, so the copy is removed rather
// than extended.
const KNOWN_TYPES: ReadonlySet<WorkItemTypeDto> = new Set(WORK_ITEM_TYPES);

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
    // Verbatim — no narrowing, no fallback. See the note above the kind guard.
    status: n.status,
    statusLabel: n.statusLabel ?? null,
    statusCategory: KNOWN_STATUS_CATEGORIES.has(n.statusCategory as StatusCategoryDto)
      ? (n.statusCategory as StatusCategoryDto)
      : null,
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
