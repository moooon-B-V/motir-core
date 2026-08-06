import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { encodePageCursor, parsePageRequest } from '@/lib/api/v1/pagination';
import {
  createWorkItemBodySchema,
  encodeWorkItemETag,
  parseV1Body,
  presentWorkItemDetail,
  presentWorkItemSummary,
} from '@/lib/api/v1/workItems/schema';
import { FILTER_PARAM, decodeFilterParam } from '@/lib/filters/ast';
import type { FilterAst } from '@/lib/filters/ast';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/projects/{projectKey}/work-items (Story 11.2 · Subtask 11.2.4 —
// MOTIR-2042) — the flagship read, and the endpoint an integration actually
// starts from.
//
// A thin adapter over the keyset read 11.2.3 ships, returning the summary shape
// 11.2.2 pins.
//
// ── ONE query grammar, never a parallel one ─────────────────────────────────
// Narrowing is the versioned FilterAST, decoded by the SAME codec the `/items`
// URL carries and `search_work_items` rides. There are deliberately NO ad-hoc
// `?status=&assignee=` axes: a second grammar is a second thing to keep in sync
// with the registry, and the first place the API and the product start
// disagreeing about what a filter MEANS. A client that can express a filter in
// the web app can send that same filter here, byte for byte.
//
// ── ⚠️ `paginateKeyset` is NOT used here ────────────────────────────────────
// It sorts and slices a FULLY-READ array — correct for `GET /api/v1/workspaces`
// (a user's own memberships) and catastrophic for a collection of 1800+ rows.
// That is the entire reason 11.2.3 exists. This route composes `parsePageRequest`
// + `encodePageCursor` and lets the DATABASE do the windowing.

export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading: a bad cursor, limit or filter is the caller's to fix,
  // and answering 422 without touching the database is both faster and honest.
  const page = parsePageRequest(ctx.req);
  const filter = parseFilterParam(ctx.req);

  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  const { items, hasMore } = await workItemsService.listProjectWorkItemsPage(
    project.id,
    { limit: page.limit, ...(page.cursor ? { after: toAfter(page.cursor) } : {}), ...filter },
    ctx.service,
  );

  // The page's dependency edges, in ONE batched call over the ids just read —
  // the BOUNDED projection ADR Amendment 3 Q4 permits and Amendment 6 Q4 applies
  // to this collection. A per-row read here would be an N+1 invisible until a
  // 100-row page; that is why the service takes an id ARRAY.
  const edges = await workItemsService.getDependencyEdgesForItems(
    items.map((item) => item.id),
    ctx.service,
  );

  const last = items[items.length - 1];
  return NextResponse.json({
    items: items.map((item) =>
      presentWorkItemSummary(
        {
          identifier: item.identifier,
          kind: item.kind,
          type: item.type,
          title: item.title,
          status: item.status,
          priority: item.priority,
          assigneeId: item.assigneeId,
          reporterId: item.reporterId,
          dueDate: item.dueDate,
          estimateMinutes: item.estimateMinutes,
          storyPoints: item.storyPoints,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt,
        },
        edges[item.id],
      ),
    ),
    // The cursor names the LAST row of THIS page, so the next request resumes
    // strictly after it. `null` on the last page — never an extra empty round
    // trip, and never a silent restart at the top.
    nextCursor:
      hasMore && last
        ? encodePageCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  });
});

// POST /api/v1/projects/{projectKey}/work-items (Subtask 11.2.6 — MOTIR-2046).
//
// A SECOND export in this module, reusing the GET's project resolution rather
// than re-deriving it, and declaring its OWN scope — the shipped guard catches
// "a POST that bypasses the wrapper even when a sibling GET does not", and the
// ADR's §3 map is per OPERATION, not per resource.
export const POST = withV1Route<{ projectKey: string }>(
  { scope: 'work_items:write' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, createWorkItemBodySchema);
    const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);

    // A `MOTIR-<n>` parent key resolves to the internal id here; a cuid never
    // crosses the wire in either direction (ADR §7). An unknown or cross-project
    // key surfaces as the service's own mapped domain error, not a 500.
    const parentId = body.parentKey
      ? (
          await workItemsService.getWorkItemByIdentifier(
            project.id,
            body.parentKey.toUpperCase(),
            ctx.service,
          )
        ).id
      : null;

    const created = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: body.kind,
        title: body.title,
        parentId,
        ...pick(body, [
          'descriptionMd',
          'priority',
          'type',
          'executor',
          'storyPoints',
          'estimateMinutes',
          'targetRepo',
          'assigneeId',
          'dueDate',
        ]),
        // ⚠️ Stamped SERVER-SIDE, exactly as the MCP tool stamps `mcp`. A row's
        // origin cannot be reconstructed after the fact, and the client does not
        // get to claim one (MOTIR-2044).
        provenance: { planning: { source: 'api' } },
      },
      ctx.service,
    );

    const detail = await workItemsService.getIssueDetail(
      project.id,
      created.identifier,
      ctx.service,
    );
    ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
    ctx.responseHeaders.set('Location', `/api/v1/work-items/${created.identifier}`);
    // A freshly created item has no children, so there is no sub-graph to
    // project — `{}` is the honest input, not a skipped read.
    return NextResponse.json(presentWorkItemDetail(detail, 0, {}), { status: 201 });
  },
);

/**
 * Copy only the keys a caller actually SUPPLIED.
 *
 * `exactOptionalPropertyTypes` makes `{ x: undefined }` and `{}` different
 * types, and the service distinguishes absent (leave alone) from null (clear) —
 * so spreading the parsed body wholesale would turn every omitted field into an
 * explicit `undefined` and blur exactly the distinction the schema drew.
 */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** The keyset position a validated cursor names, in the shape the service takes. */
function toAfter(cursor: { createdAt: string; id: string }): { createdAt: Date; id: string } {
  return { createdAt: new Date(cursor.createdAt), id: cursor.id };
}

/**
 * Decode `?filter=` into the AST the service takes, or `{}` when absent.
 *
 * A decode failure is a **422 with a stable code**, distinguishing the two
 * causes a client can actually act on differently: a param that is not a filter
 * at all (`INVALID_FILTER`) versus one written against a version this API does
 * not speak (`UNSUPPORTED_FILTER_VERSION` — the signal to upgrade, not to
 * re-encode). Deeper failures (unknown field, unknown operator, bad value, over
 * the row cap) are raised by `validateFilterAst` beneath the service and carry
 * their own codes into `DOMAIN_ERROR_STATUS`.
 */
function parseFilterParam(req: Request): { filter?: { ast: FilterAst } } {
  const raw = new URL(req.url).searchParams.get(FILTER_PARAM);
  if (raw === null || raw === '') return {};

  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) {
    if (decoded.reason === 'unsupported-version') {
      throw new InvalidRequestError(
        'UNSUPPORTED_FILTER_VERSION',
        `The \`filter\` parameter uses an unsupported version: ${decoded.detail}.`,
      );
    }
    if (decoded.reason === 'too-large') {
      // The SAME code the registry's `FilterTooLargeError` maps to, so an
      // over-cap filter reports identically whether the codec catches it (the
      // URL carrier) or `validateFilterAst` does (any other path).
      throw new InvalidRequestError(
        'FILTER_TOO_LARGE',
        `The \`filter\` parameter is ${decoded.detail}.`,
      );
    }
    throw new InvalidRequestError(
      'INVALID_FILTER',
      'The `filter` parameter is not a valid encoded filter.',
    );
  }
  return { filter: { ast: decoded.ast } };
}
