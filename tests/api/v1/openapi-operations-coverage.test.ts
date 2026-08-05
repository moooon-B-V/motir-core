import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { operationKey } from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { meSchema, workspaceSummarySchema } from '@/lib/api/v1/identity/schema';
import { v1PageEnvelopeSchema } from '@/lib/api/v1/openapi/envelopes';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { declaredScopeByMethod, v1RouteFiles } from '../../helpers/v1RouteAudit';
import { createV1Caller, type V1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// EVERY `/api/v1` operation is declared (Story 11.4 · Subtask 11.4.5 —
// MOTIR-2186).
//
// The card refused to carry its own list of endpoints, and so does this suite:
// it WALKS `app/api/v1` with the shipped `v1RouteFiles()` and reads each
// exported verb's scope with the shipped `declaredScopeByMethod()`. A list of
// what exists today is wrong the first time someone adds an endpoint; an
// instruction to go and look stays correct.
//
// ⚠️ This is NOT yet Subtask 11.4.6's full drift guard. It asserts the
// ROUTE → OPERATION direction (every exported verb is documented) and the scope
// equality. The converse — an operation naming no route — and the
// response-validates-against-its-schema check are 11.4.6's, which needs this
// card's completeness to be assertable at all.

const REPO_ROOT = process.cwd();

/** Turn a route FILE path into the OpenAPI path template it serves. */
function pathTemplateFor(routeFile: string): string {
  const segments = relative(join('app'), routeFile)
    .split(sep)
    .slice(0, -1) // drop `route.ts`
    .map((segment) => (segment.startsWith('[') ? `{${segment.slice(1, -1)}}` : segment));
  return `/${segments.join('/')}`;
}

/** Every (method, path) the shipped route tree actually exports. */
function shippedRouteMethods(): { method: string; path: string; file: string; scope?: string }[] {
  const found: { method: string; path: string; file: string; scope?: string }[] = [];
  for (const file of v1RouteFiles(REPO_ROOT)) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const [method, scope] of declaredScopeByMethod(source)) {
      found.push({ method, path: pathTemplateFor(file), file, ...(scope ? { scope } : {}) });
    }
  }
  return found;
}

describe('every shipped /api/v1 route method has a declared operation', () => {
  it('finds routes at all — the walk itself is not silently empty', () => {
    // A walk that returned nothing would make every assertion below vacuously
    // true, which is the failure mode of a discovery-based check.
    expect(v1RouteFiles(REPO_ROOT).length).toBeGreaterThan(10);
    expect(shippedRouteMethods().length).toBeGreaterThan(15);
  });

  it('declares an operation for EVERY exported verb, discovered by walking the tree', () => {
    const undocumented = shippedRouteMethods()
      .filter((route) => findV1Operation(route.method, route.path) === undefined)
      .map((route) => `${route.method} ${route.path} (${route.file})`);
    expect(undocumented, `undocumented v1 operations: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('does not document the SPEC route — the one named exception', () => {
    // `/api/openapi/v1.json` is not a v1 route (ADR Amendment 4 Q3 put it
    // outside the tree deliberately), so it is not in the walk and must not be
    // in the registry either: it is the document, not an operation in it.
    expect(findV1Operation('GET', '/api/openapi/v1.json')).toBeUndefined();
    expect(v1RouteFiles(REPO_ROOT).some((f) => f.includes('openapi'))).toBe(false);
  });

  it('declares the scope each route file ACTUALLY declares to withV1Route', () => {
    for (const route of shippedRouteMethods()) {
      const operation = findV1Operation(route.method, route.path);
      expect(operation, `${route.method} ${route.path} undocumented`).toBeDefined();
      // `undefined` here means the route exports a verb whose scope could not be
      // read — a hole the audit deliberately surfaces rather than skipping.
      expect(
        route.scope,
        `${route.file} exports ${route.method} with no readable scope`,
      ).toBeDefined();
      expect(operation?.scope, `${route.method} ${route.path}`).toBe(route.scope);
    }
  });

  it('declares no operation for a route that does not exist', () => {
    const shipped = new Set(shippedRouteMethods().map((r) => `${r.method} ${r.path}`));
    const orphans = V1_OPERATIONS.filter((op) => !shipped.has(operationKey(op))).map(operationKey);
    expect(orphans, `operations with no route: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('the completed document', () => {
  const document = emitOpenApiDocument();

  it('still validates as OpenAPI 3.1 with the full operation set', async () => {
    const result = await new Validator().validate(structuredClone(document));
    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('covers every shipped path', () => {
    const paths = Object.keys(document['paths'] as object);
    for (const route of shippedRouteMethods()) {
      expect(paths, `${route.path} missing from the document`).toContain(route.path);
    }
  });

  it('gives the two RANKED collections the ranked envelope and everyone else the plain one', () => {
    // Amendment 3 Q2's split, asserted rather than inferred — and it is not the
    // split a reader would guess, which is exactly why it is pinned here.
    const ranked = V1_OPERATIONS.filter((op) => op.response.body.kind === 'rankedPage').map(
      operationKey,
    );
    expect(ranked.sort()).toEqual(
      [
        'GET /api/v1/projects/{projectKey}/backlog',
        'GET /api/v1/sprints/{sprintId}/work-items',
        'GET /api/v1/work-items/{key}/comments',
      ].sort(),
    );
    // The ready set and the project list have no cheap count, so they are plain.
    expect(findV1Operation('GET', '/api/v1/projects/{projectKey}/ready')?.response.body.kind).toBe(
      'page',
    );
    expect(findV1Operation('GET', '/api/v1/projects')?.response.body.kind).toBe('page');
  });

  it('names 409 and 412 exactly where the write endpoints use them', () => {
    // Not "somewhere in the document": on the operations whose routes can
    // actually raise them, drawn from DOMAIN_ERROR_STATUS.
    expect(findV1Operation('PATCH', '/api/v1/work-items/{key}')?.errorStatuses).toContain(412);
    expect(findV1Operation('POST', '/api/v1/work-items/{key}/links')?.errorStatuses).toContain(409);
    expect(findV1Operation('POST', '/api/v1/sprints/{sprintId}/start')?.errorStatuses).toContain(
      409,
    );
    expect(findV1Operation('PATCH', '/api/v1/sprints/{sprintId}')?.errorStatuses).toContain(409);
  });
});

describe('the identity schemas describe what the REAL routes return', () => {
  let caller: V1Caller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1Caller({ scopes: ['read'] });
  });

  // The two shapes this card had to declare (Story 11.1 shipped these endpoints
  // before Amendment 2 assigned schema ownership, so neither had one). They are
  // proven against the endpoints themselves — a fixture written from the same
  // assumption as the schema would prove only that the author was consistent.

  it('GET /api/v1/me returns exactly what `meSchema` declares', async () => {
    const { GET } = await import('@/app/api/v1/me/route');
    const res = await GET(
      new Request('http://localhost:3000/api/v1/me', { headers: caller.headers }),
    );

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = meSchema.parse(body);
    expect(parsed.workspaceId).toBe(caller.workspace.id);
    expect(parsed.user.id).toBe(caller.user.id);
    expect(parsed.scopes).toEqual(['read']);
  });

  it('GET /api/v1/workspaces returns rows exactly as `workspaceSummarySchema` declares', async () => {
    const { GET } = await import('@/app/api/v1/workspaces/route');
    const res = await GET(
      new Request('http://localhost:3000/api/v1/workspaces', { headers: caller.headers }),
    );

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const page = v1PageEnvelopeSchema(workspaceSummarySchema).parse(body);
    expect(page.items.map((w) => w.id)).toContain(caller.workspace.id);
  });
});
