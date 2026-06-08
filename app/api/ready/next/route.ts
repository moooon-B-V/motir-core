import { NextResponse } from 'next/server';
import { WorkItemKind, WorkItemPriority } from '@prisma/client';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ReadyListFilter } from '@/lib/workItems/readyFilter';

// POST /api/ready/next (Subtask 7.0.5) — the DISPATCH half of the agent-dispatch
// surface (Story 7.0). Give me ONE thing to run next: returns the first ready
// work item under the deterministic `(priority desc, key asc)` sort that is NOT
// in `excludeIds`, as the full `ReadyItemDispatchDto` (body + contextRefs +
// resolved blocker keys + parentKey + runCommand — the payload a coding agent
// stuffs into its prompt), or `204 No Content` when the filtered ready set is
// empty. The BROWSE-the-whole-set consumer reads `GET /api/ready` (7.0.4); both
// share `workItemsService` (the readiness predicate + sort live there) so the
// page and the agent can never disagree on what "ready" means.
//
// Thin HTTP layer (CLAUDE.md 4-layer rule). The route only: reads the workspace
// context (session), parses + hand-validates the JSON body, resolves
// `projectKey` → a project, calls ONE service method per branch, and maps typed
// errors to status codes. No `db` / no `$transaction` here.
//
// Why POST + a JSON body (not GET + query, like 7.0.4): the body carries
// `excludeIds` — a list that GROWS with every agent-loop iteration (the picks it
// has already dispatched). Query-string GETs blow past URL-length limits and
// force CLI consumers into escaping; a JSON body is the honest shape for the
// dispatch contract.
//
// Why `?projectKey` and not the active-project cookie (cf. /api/board, which uses
// getActiveProject()): this is the AGENT contract — a stable endpoint a BYOK CLI
// can curl with an explicit, scriptable project, independent of whatever project
// the user's browser session last activated. The workspace still comes from the
// session (getWorkspaceContext — the agent acts AS the signed-in user); only the
// project is named explicitly, and resolved within that workspace so a
// cross-tenant key is indistinguishable from a non-existent one (404, never a
// 403 that would confirm the key exists — the no-existence-leak contract,
// PRODECT_FINDINGS #26).

const KINDS = new Set<string>(Object.values(WorkItemKind));
const PRIORITIES = new Set<string>(Object.values(WorkItemPriority));

/** A body field that failed validation — the route turns it into a 400. */
class BadBodyError extends Error {}

/** The validated dispatch filter, ready to hand to `workItemsService.getNextReady`. */
type DispatchFilter = Omit<ReadyListFilter, 'limit' | 'cursor'> & { excludeIds?: string[] };

/**
 * Parse an "any of" enum facet (`kinds`, `priority`) off the body. Absent →
 * undefined (= the service default, "any"); present → the de-duplicated set, but
 * any value outside the enum is a hard 400 (a typo'd facet silently returning
 * "everything" would mislead an agent walking the set). Must be an array of
 * strings when present.
 */
function parseEnumArray<T extends string>(
  raw: unknown,
  allowed: Set<string>,
  label: string,
): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new BadBodyError(`\`${label}\` must be an array.`);
  const values: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !allowed.has(v)) {
      throw new BadBodyError(`Unknown ${label}: ${JSON.stringify(v)}.`);
    }
    values.push(v);
  }
  if (values.length === 0) return undefined;
  return [...new Set(values)] as T[];
}

/**
 * The body's `assigneeId` is tri-state, matching `ReadyListFilter.assigneeId`:
 *   - absent (`undefined`)        → any assignee (filter omitted)
 *   - `null` or `"unassigned"`    → the UNASSIGNED bucket (mapped to `null`)
 *   - a non-blank id string       → that user's items
 * Both the literal `null` and the `"unassigned"` sentinel resolve to the same
 * `null` the service uses for the unassigned bucket — a CLI can send whichever
 * is convenient. Anything else (a number, a blank string) is a 400.
 */
function parseAssigneeId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'unassigned') return null;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  throw new BadBodyError('`assigneeId` must be a user id, "unassigned", or null.');
}

/** `excludeIds` (absent → undefined): the agent's already-dispatched picks. */
function parseExcludeIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw new BadBodyError('`excludeIds` must be an array of work item ids.');
  }
  return raw as string[];
}

/** Parse + validate the whole body into `{ projectKey, filter }`, or throw `BadBodyError`. */
function parseBody(body: unknown): { projectKey: string; filter: DispatchFilter } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadBodyError('Expected a JSON object body.');
  }
  const b = body as Record<string, unknown>;

  const projectKey = typeof b.projectKey === 'string' ? b.projectKey.trim() : '';
  if (!projectKey) throw new BadBodyError('`projectKey` is required.');

  return {
    projectKey,
    filter: {
      kinds: parseEnumArray<WorkItemKind>(b.kinds, KINDS, 'kinds'),
      priority: parseEnumArray<WorkItemPriority>(b.priority, PRIORITIES, 'priority'),
      assigneeId: parseAssigneeId(b.assigneeId),
      excludeIds: parseExcludeIds(b.excludeIds),
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON object body.' },
      { status: 400 },
    );
  }

  let projectKey: string;
  let filter: DispatchFilter;
  try {
    ({ projectKey, filter } = parseBody(raw));
  } catch (err) {
    if (err instanceof BadBodyError) {
      return NextResponse.json({ code: 'BAD_REQUEST', error: err.message }, { status: 400 });
    }
    throw err;
  }

  try {
    // projectKey → projectId (within the actor's workspace; cross-tenant /
    // unknown → ProjectNotFoundError → 404, no existence leak). `getByKey` is the
    // shared agent-dispatch resolver authored by 7.0.4 (this route depends on it).
    const project = await projectsService.getByKey(projectKey, ctx);

    const dispatch = await workItemsService.getNextReady(project.id, filter, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    // "Give me ONE thing; there is nothing." 204 (not 200 `{ items: [] }`) keeps
    // an empty ready set against a REAL project unambiguous vs. a missing project
    // (which already 404'd above).
    if (!dispatch) return new NextResponse(null, { status: 204 });

    return NextResponse.json(dispatch);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
