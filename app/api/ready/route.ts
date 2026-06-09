import { NextResponse } from 'next/server';
import { WorkItemKind, WorkItemPriority } from '@prisma/client';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidReadyCursorError, type ReadyListFilter } from '@/lib/workItems/readyFilter';

// GET /api/ready (Subtask 7.0.4) — the LIST half of the agent-dispatch surface
// (Story 7.0). Returns every ready-to-start work item in a project as a page of
// cheap `ReadyItemDto` card rows: `{ items, nextCursor }`. The /ready page's
// server fetch and any BYOK agent that wants to BROWSE the ready set both read
// this; the DISPATCH-one-item consumer reads `POST /api/ready/next` (7.0.5).
//
// Thin HTTP layer over `workItemsService.listReady` (the readiness predicate +
// `(type asc, priority desc, key asc)` sort + cursor live there). The route only: reads
// the workspace context (session), parses + hand-validates the query, resolves
// `?projectKey` → a project, calls ONE service method, and maps typed errors to
// status codes. No `db` / no `$transaction` here (CLAUDE.md 4-layer rule).
//
// Why `?projectKey=` and not the active-project cookie (cf. /api/board, which
// uses getActiveProject()): this is the AGENT contract — a stable URL a BYOK
// CLI can curl with an explicit, scriptable project, independent of whatever
// project the user's browser session last activated. The workspace still comes
// from the session (getWorkspaceContext) — the agent acts AS the signed-in
// user — but the project is named explicitly, and resolved within that
// workspace so a cross-tenant key is indistinguishable from a non-existent one
// (404, never 403 — the no-existence-leak contract, PRODECT_FINDINGS #26).

/** A non-blank query value, or undefined when the param is absent/blank. */
function param(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name)?.trim();
  return raw ? raw : undefined;
}

const KINDS = new Set<string>(Object.values(WorkItemKind));
const PRIORITIES = new Set<string>(Object.values(WorkItemPriority));

/** A query param that failed validation — the route turns it into a 400. */
class BadQueryError extends Error {}

/**
 * Parse a comma-separated enum facet (`kinds`, `priority`). Absent → undefined
 * (= "any", the service's default); present → the de-duplicated set, but any
 * value outside the enum is a hard 400 (a typo'd facet silently returning
 * "everything" would mislead an agent walking the set).
 */
function parseEnumCsv<T extends string>(
  raw: string | undefined,
  allowed: Set<string>,
  label: string,
): T[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (values.length === 0) return undefined;
  for (const v of values) {
    if (!allowed.has(v)) throw new BadQueryError(`Unknown ${label}: "${v}".`);
  }
  return [...new Set(values)] as T[];
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;

  const projectKey = param(params, 'projectKey');
  if (!projectKey) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`projectKey` is required.' },
      { status: 400 },
    );
  }

  let filter: ReadyListFilter;
  try {
    const assigneeRaw = param(params, 'assigneeId');
    const limitRaw = param(params, 'limit');
    filter = {
      kinds: parseEnumCsv<WorkItemKind>(param(params, 'kinds'), KINDS, 'kind'),
      priority: parseEnumCsv<WorkItemPriority>(param(params, 'priority'), PRIORITIES, 'priority'),
      // tri-state: absent → any (undefined); the literal "unassigned" → the
      // UNASSIGNED bucket (null); any other value → that assignee's id.
      assigneeId:
        assigneeRaw === undefined ? undefined : assigneeRaw === 'unassigned' ? null : assigneeRaw,
      cursor: param(params, 'cursor'),
      // A non-numeric `limit` parses to NaN; the service's clampReadyLimit maps
      // NaN/over-cap → the default/200 (clamped silently, not 400 — friendlier
      // for a CLI). So we forward the raw number and let the service clamp.
      limit: limitRaw === undefined ? undefined : Number(limitRaw),
    };
  } catch (err) {
    if (err instanceof BadQueryError) {
      return NextResponse.json({ code: 'BAD_REQUEST', error: err.message }, { status: 400 });
    }
    throw err;
  }

  try {
    // Resolve the key within the actor's workspace (404 on miss/cross-tenant),
    // then list the ready page. listReady re-gates the projectId to the same
    // workspace (defense in depth) and decodes the cursor.
    const project = await projectsService.getByKey(projectKey, ctx);
    const page = await workItemsService.listReady(project.id, filter, ctx);
    return NextResponse.json(page, {
      // Readiness flips with every status change; never serve a stale page.
      // Etag/Last-Modified would be premature for a set this volatile.
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidReadyCursorError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    throw err;
  }
}
