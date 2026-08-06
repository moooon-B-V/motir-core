import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  emitOpenApiDocument,
  toOpenApiSchema,
  V1_CONTRACT_VERSION,
} from '@/lib/api/v1/openapi/emit';
import {
  V1_PAGE_ENVELOPE_COMPONENT,
  V1_RANKED_PAGE_ENVELOPE_COMPONENT,
} from '@/lib/api/v1/openapi/envelopes';
import {
  V1_ERROR_BODY_COMPONENT,
  V1_INTERNAL_ERROR_BODY_COMPONENT,
} from '@/lib/api/v1/openapi/errorResponse';
import { defineOperation, operationKey, V1_METHODS } from '@/lib/api/v1/openapi/operation';
import {
  buildOperationRegistry,
  findV1Operation,
  mergeResourceComponents,
  V1_OPERATION_REGISTRY,
  V1_OPERATIONS,
  V1_RESOURCE_COMPONENTS,
  v1OperationIds,
} from '@/lib/api/v1/openapi/registry';
import { V1_SCOPE_EXTENSION, V1_SECURITY_SCHEME_NAME } from '@/lib/api/v1/openapi/security';
import { isV1ErrorStatus, isV1Status } from '@/lib/api/v1/openapi/statuses';
import { workItemSummarySchema } from '@/lib/api/v1/workItems/schema';
import { declaredScopeByMethod } from '../../helpers/v1RouteAudit';

// The operation registry + the OpenAPI 3.1 emitter (Story 11.4 · Subtask 11.4.4
// — MOTIR-2185).
//
// The document is checked against a REAL OpenAPI 3.1 validator
// (`@seriousme/openapi-schema-validator`, which validates against the official
// 3.1 JSON Schema), not against a hand-written shape check that would only ever
// confirm what the emitter already believes.
//
// ⚠️ Scope: the registry holds the WORK-ITEM operations only. The remaining
// resources are Subtask 11.4.5 and the totality guard that FAILS on the gap is
// Subtask 11.4.6 — so this suite asserts that every DECLARED operation matches a
// real route, and deliberately does not yet assert the converse.

const REPO_ROOT = process.cwd();

/** Turn an OpenAPI path template into the route file that serves it. */
function routeFileFor(path: string): string {
  const segments = path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => (segment.startsWith('{') ? `[${segment.slice(1, -1)}]` : segment));
  return join('app', ...segments, 'route.ts');
}

describe('the v1 operation registry', () => {
  it('declares at least one operation, keyed by verb and path', () => {
    expect(V1_OPERATIONS.length).toBeGreaterThan(0);
    expect(V1_OPERATION_REGISTRY.size).toBe(V1_OPERATIONS.length);
    for (const operation of V1_OPERATIONS) {
      expect(V1_OPERATION_REGISTRY.get(operationKey(operation))).toBe(operation);
    }
  });

  it('uses only the verbs v1 exposes', () => {
    for (const operation of V1_OPERATIONS) {
      expect(V1_METHODS).toContain(operation.method);
    }
  });

  it('gives every operation a UNIQUE operationId — a generator names a method after it', () => {
    const ids = v1OperationIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares only statuses the vocabulary documents', () => {
    for (const operation of V1_OPERATIONS) {
      expect(isV1Status(operation.response.status), operation.operationId).toBe(true);
      for (const status of operation.errorStatuses) {
        expect(isV1ErrorStatus(status), `${operation.operationId} → ${status}`).toBe(true);
      }
    }
  });

  it('looks an operation up by verb and path', () => {
    expect(findV1Operation('GET', '/api/v1/work-items/{key}')?.operationId).toBe('getWorkItem');
    expect(findV1Operation('GET', '/api/v1/nope')).toBeUndefined();
  });

  it('REFUSES two modules that claim one operation', () => {
    // The guard, driven with a violation — the same discipline
    // `tests/helpers/v1RouteAudit.ts` applies to its own rules. A silent
    // last-wins overwrite would leave a document that still looks complete.
    const first = V1_OPERATIONS[0];
    expect(first).toBeDefined();
    expect(() => buildOperationRegistry([first!, first!])).toThrow(/duplicate v1 operation/);
  });

  it('REFUSES two modules that claim one component NAME', () => {
    const resource = { operations: [], components: { WorkItemSummary: workItemSummarySchema } };
    expect(() => mergeResourceComponents([resource, resource])).toThrow(/duplicate v1 component/);
  });

  it('gives a 204 operation an EMPTY body and every other one a real shape', () => {
    for (const operation of V1_OPERATIONS) {
      const isEmpty = operation.response.body.kind === 'empty';
      expect(isEmpty, operation.operationId).toBe(operation.response.status === 204);
    }
  });
});

describe('the registry against the SHIPPED route tree', () => {
  it('points every declared operation at a route file that exists', () => {
    for (const operation of V1_OPERATIONS) {
      const file = routeFileFor(operation.path);
      expect(() => readFileSync(join(REPO_ROOT, file), 'utf8'), `${file} missing`).not.toThrow();
    }
  });

  it('declares the scope the route file ACTUALLY declares to withV1Route', () => {
    // The independent second opinion ADR Amendment 4 Q2 keeps the registry as:
    // the route enforces, the registry documents, and this is where they are
    // reconciled. A mismatch here is a document that lies about a permission.
    for (const operation of V1_OPERATIONS) {
      const source = readFileSync(join(REPO_ROOT, routeFileFor(operation.path)), 'utf8');
      const declared = declaredScopeByMethod(source).get(operation.method);
      expect(declared, `${operation.method} ${operation.path} declares no readable scope`).toBe(
        operation.scope,
      );
    }
  });
});

describe('the emitted document', () => {
  const document = emitOpenApiDocument();

  it('validates against a REAL OpenAPI 3.1 validator', async () => {
    const result = await new Validator().validate(structuredClone(document));
    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('declares 3.1 and the CONTRACT version, not the app’s release number', () => {
    expect(document['openapi']).toBe('3.1.0');
    const info = document['info'] as unknown as Record<string, unknown>;
    expect(info['version']).toBe(V1_CONTRACT_VERSION);
    expect(V1_CONTRACT_VERSION).toMatch(/^1\.\d+\.\d+$/);
  });

  // MOTIR-2275. Asserted against the EMITTED DOCUMENT and by LITERAL name, not
  // against `V1_SHARED_RESPONSE_HEADERS` — a check that maps over the same
  // constant the emitter reads would pass on a document that declared nothing
  // at all. This is the criterion "it appears on every operation" as a reader
  // of the published spec would verify it.
  it('declares X-Motir-Api-Version on EVERY response of EVERY operation', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>
    >;
    let checked = 0;
    for (const operation of V1_OPERATIONS) {
      const responses = paths[operation.path]?.[operation.method.toLowerCase()]?.responses ?? {};
      for (const [status, response] of Object.entries(responses)) {
        const header = response.headers?.['X-Motir-Api-Version'] as
          | { description?: string; schema?: unknown }
          | undefined;
        expect(header, `${operation.path} ${operation.method} ${status}`).toBeDefined();
        expect(header?.description ?? '').toMatch(/contract/i);
        expect(header?.schema).toBeDefined();
        checked += 1;
      }
    }
    // The sweep is not vacuous — every operation carries its wrapper statuses.
    expect(checked).toBeGreaterThan(100);
  });

  it('carries every declared operation at its own path and verb', () => {
    const paths = document['paths'] as unknown as Record<string, Record<string, unknown>>;
    for (const operation of V1_OPERATIONS) {
      const entry = paths[operation.path];
      expect(entry, `no path entry for ${operation.path}`).toBeDefined();
      expect(entry?.[operation.method.toLowerCase()], operationKey(operation)).toBeDefined();
    }
  });

  it('gives every operation its scope, its security requirement and its parameters', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    for (const operation of V1_OPERATIONS) {
      const emitted = paths[operation.path]?.[operation.method.toLowerCase()] ?? {};
      expect(emitted[V1_SCOPE_EXTENSION], operation.operationId).toBe(operation.scope);
      expect(emitted['security']).toEqual([{ [V1_SECURITY_SCHEME_NAME]: [] }]);
      const parameters = (emitted['parameters'] ?? []) as { name: string }[];
      expect(parameters.map((p) => p.name)).toEqual(operation.parameters.map((p) => p.name));
    }
  });

  // MOTIR-2317. The ready set's `kind` / `priority` were declared as SCALARS
  // while their own descriptions said "Repeatable" and the route read them with
  // `params.getAll` — an under-description nobody noticed until a client was
  // GENERATED from this document and inherited a type that cannot express two
  // kinds. The declaration and the wire form are asserted together, off the
  // emitted document rather than a fixture, so the two cannot drift apart again.
  // MOTIR-2320 / ADR Amendment 12. A ranked page may EXTEND the envelope with
  // fields that belong to its own read. The separation is the point: a reader
  // must be able to see which fields are paging and which are this operation's,
  // so the extension rides as its own `allOf` member rather than being merged.
  it('emits a ranked page’s EXTENSION as its own allOf member, beside the envelope', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const responses = paths['/api/v1/work-items/{key}/activity']?.['get']?.['responses'] as Record<
      string,
      { content: { 'application/json': { schema: { allOf: Record<string, unknown>[] } } } }
    >;
    const branches = responses['200']?.content['application/json'].schema.allOf ?? [];

    expect(branches).toHaveLength(3);
    expect(branches[0]?.['$ref']).toBe(`#/components/schemas/${V1_RANKED_PAGE_ENVELOPE_COMPONENT}`);
    expect(Object.keys((branches[1]?.['properties'] ?? {}) as object)).toEqual(['items']);
    expect(Object.keys((branches[2]?.['properties'] ?? {}) as object)).toEqual([
      'totalComments',
      'totalChanges',
    ]);

    // A ranked page WITHOUT an extension still emits exactly two members — the
    // branch has both sides, and this is the one that is easy to lose.
    const comments = paths['/api/v1/work-items/{key}/comments']?.['get']?.['responses'] as Record<
      string,
      { content: { 'application/json': { schema: { allOf: unknown[] } } } }
    >;
    expect(comments['200']?.content['application/json'].schema.allOf).toHaveLength(2);
  });

  it('declares the ready set’s repeatable filters as exploded ARRAYS', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const parameters = (paths['/api/v1/projects/{projectKey}/ready']?.['get']?.['parameters'] ??
      []) as { name: string; explode?: boolean; schema?: { type?: string; items?: unknown } }[];

    for (const name of ['kind', 'priority']) {
      const parameter = parameters.find((p) => p.name === name);
      expect(parameter, name).toBeDefined();
      expect(parameter?.schema?.type, name).toBe('array');
      expect(parameter?.schema?.items, name).toBeDefined();
      // `?kind=a&kind=b`, which is what `getAll` reads. A `false` here would
      // mean `?kind=a,b` — one kind, named `a,b`, matching nothing.
      expect(parameter?.explode, name).toBe(true);
    }

    // `assigneeId` sits beside them and is TRI-STATE, not repeatable: a second
    // value would have no meaning, so it stays a scalar with no `explode`.
    const assignee = parameters.find((p) => p.name === 'assigneeId');
    expect(assignee?.schema?.type).toBe('string');
    expect(assignee?.explode).toBeUndefined();
  });

  it('gives every operation the wrapper’s errors as well as its own', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    for (const operation of V1_OPERATIONS) {
      const emitted = paths[operation.path]?.[operation.method.toLowerCase()] ?? {};
      const responses = Object.keys((emitted['responses'] ?? {}) as object);
      for (const status of [401, 403, 429, 500, ...operation.errorStatuses]) {
        expect(responses, `${operation.operationId} is missing ${status}`).toContain(
          String(status),
        );
      }
      expect(responses).toContain(String(operation.response.status));
    }
  });

  it('routes 500 to the code-less body and every other failure to the coded one', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, never>>
    >;
    const detail = paths['/api/v1/work-items/{key}']?.['get']?.['responses'] as unknown as Record<
      string,
      { content: { 'application/json': { schema: { $ref: string } } } }
    >;
    expect(detail['500']?.content['application/json'].schema.$ref).toContain(
      V1_INTERNAL_ERROR_BODY_COMPONENT,
    );
    expect(detail['404']?.content['application/json'].schema.$ref).toContain(
      V1_ERROR_BODY_COMPONENT,
    );
  });

  it('puts the shared response headers on a SUCCESS and on an ERROR alike', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, never>>
    >;
    const responses = paths['/api/v1/work-items/{key}']?.['get']?.[
      'responses'
    ] as unknown as Record<string, { headers: Record<string, unknown> }>;
    for (const status of ['200', '404', '429']) {
      expect(Object.keys(responses[status]?.headers ?? {})).toEqual([
        'X-Request-Id',
        'X-Motir-Api-Version',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ]);
    }
  });

  it('references the PLAIN envelope for a plain collection', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, never>>
    >;
    const schema = paths['/api/v1/projects/{projectKey}/work-items']?.['get']?.[
      'responses'
    ] as unknown as Record<
      string,
      { content: { 'application/json': { schema: { allOf: { $ref?: string }[] } } } }
    >;
    const refs = schema['200']?.content['application/json'].schema.allOf.map((s) => s.$ref);
    expect(refs).toContain(`#/components/schemas/${V1_PAGE_ENVELOPE_COMPONENT}`);
    expect(refs).not.toContain(`#/components/schemas/${V1_RANKED_PAGE_ENVELOPE_COMPONENT}`);
  });

  it('references the RANKED envelope for the collection that reports a total', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, never>>
    >;
    const schema = paths['/api/v1/work-items/{key}/comments']?.['get']?.[
      'responses'
    ] as unknown as Record<
      string,
      { content: { 'application/json': { schema: { allOf: { $ref?: string }[] } } } }
    >;
    const refs = schema['200']?.content['application/json'].schema.allOf.map((s) => s.$ref);
    expect(refs).toContain(`#/components/schemas/${V1_RANKED_PAGE_ENVELOPE_COMPONENT}`);
    expect(refs).not.toContain(`#/components/schemas/${V1_PAGE_ENVELOPE_COMPONENT}`);
  });

  it('omits a response body entirely for the 204', () => {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<string, Record<string, never>>
    >;
    const responses = paths['/api/v1/work-items/{key}/links']?.['delete']?.[
      'responses'
    ] as unknown as Record<string, Record<string, unknown>>;
    expect(responses['204']).toBeDefined();
    expect(responses['204']?.['content']).toBeUndefined();
  });

  it('registers every shared and resource component, and every $ref resolves', () => {
    const components = (
      document['components'] as unknown as Record<string, Record<string, unknown>>
    )['schemas'] as unknown as Record<string, unknown>;
    for (const name of [
      V1_ERROR_BODY_COMPONENT,
      V1_INTERNAL_ERROR_BODY_COMPONENT,
      V1_PAGE_ENVELOPE_COMPONENT,
      V1_RANKED_PAGE_ENVELOPE_COMPONENT,
      ...Object.keys(V1_RESOURCE_COMPONENTS),
    ]) {
      expect(components[name], `component ${name} missing`).toBeDefined();
    }
    // Every reference in the whole document points at something that exists —
    // a dangling `$ref` is the failure a shape check would not catch.
    const refs = [
      ...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, name] of refs) {
      expect(components[name as string], `dangling $ref to ${name}`).toBeDefined();
    }
  });

  it('emits the bearer PAT as the one security scheme', () => {
    const schemes = (document['components'] as unknown as Record<string, Record<string, never>>)[
      'securitySchemes'
    ] as unknown as Record<string, { type: string; scheme: string }>;
    expect(Object.keys(schemes)).toEqual([V1_SECURITY_SCHEME_NAME]);
    expect(schemes[V1_SECURITY_SCHEME_NAME]?.type).toBe('http');
    expect(schemes[V1_SECURITY_SCHEME_NAME]?.scheme).toBe('bearer');
  });

  it('is DETERMINISTIC — two emissions are byte-identical', () => {
    expect(JSON.stringify(emitOpenApiDocument())).toBe(JSON.stringify(emitOpenApiDocument()));
  });

  it('advertises a server only when the deployment supplies one', () => {
    expect(document['servers']).toBeUndefined();
    expect(emitOpenApiDocument({ serverUrl: 'https://app.motir.co' })['servers']).toEqual([
      { url: 'https://app.motir.co' },
    ]);
  });
});

describe('one document per API MAJOR', () => {
  it('produces a SECOND document for a second major, not a mutated first', () => {
    const v1 = emitOpenApiDocument();
    const v2 = emitOpenApiDocument({ major: 2, contractVersion: '2.0.0' });

    expect(v2).not.toBe(v1);
    // `v2` has no operations yet — every declared path is under `/api/v1/`, and
    // an operation outside a document's major belongs to a DIFFERENT document
    // rather than to a filtered corner of this one.
    expect(Object.keys(v2['paths'] as object)).toEqual([]);
    expect(Object.keys(v1['paths'] as object).length).toBeGreaterThan(0);
    expect((v2['info'] as unknown as Record<string, unknown>)['version']).toBe('2.0.0');
    // Emitting v2 did not disturb v1.
    expect(JSON.stringify(emitOpenApiDocument())).toBe(JSON.stringify(v1));
  });
});

describe('toOpenApiSchema', () => {
  it('emits 2020-12 shapes with no $schema keyword', () => {
    const emitted = toOpenApiSchema(workItemSummarySchema);
    expect(emitted['$schema']).toBeUndefined();
    expect(emitted['type']).toBe('object');
    expect(Object.keys(emitted['properties'] as object)).toContain('key');
  });

  it('converts on the INPUT side when asked — a request body, not a response', () => {
    const withDefault = z.object({ n: z.number().default(3) });
    expect(toOpenApiSchema(withDefault, 'input')['required']).toBeUndefined();
    expect(toOpenApiSchema(withDefault, 'output')['required']).toEqual(['n']);
  });
});

describe('the operation TYPE refuses an incomplete declaration', () => {
  it('does not typecheck without a scope, a response or error statuses', () => {
    // These are COMPILE assertions: if any required field ever became optional,
    // the suppression below would be unnecessary and `pnpm typecheck` would fail
    // on it. That is the compile-failure proof the acceptance criteria ask for —
    // a runtime check cannot see a type that no longer constrains anything.
    const noScope = () =>
      // @ts-expect-error — `scope` is required.
      defineOperation({
        method: 'GET',
        path: '/api/v1/x',
        operationId: 'x',
        summary: 's',
        description: 'd',
        parameters: [],
        response: { status: 200, body: { kind: 'empty' }, description: 'd' },
        errorStatuses: [],
      });
    const noResponse = () =>
      // @ts-expect-error — `response` is required.
      defineOperation({
        method: 'GET',
        path: '/api/v1/x',
        operationId: 'x',
        summary: 's',
        description: 'd',
        scope: 'read',
        parameters: [],
        errorStatuses: [],
      });
    const badStatus = () =>
      defineOperation({
        method: 'GET',
        path: '/api/v1/x',
        operationId: 'x',
        summary: 's',
        description: 'd',
        scope: 'read',
        parameters: [],
        response: { status: 200, body: { kind: 'empty' }, description: 'd' },
        // @ts-expect-error — 418 is not in the error-status vocabulary.
        errorStatuses: [418],
      });

    expect([noScope, noResponse, badStatus].every((f) => typeof f === 'function')).toBe(true);
  });
});
