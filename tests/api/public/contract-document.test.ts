import { describe, expect, it } from 'vitest';
import { PUBLIC_CONTRACT_VERSION } from '@/lib/api/public/contractVersion';
import { emitPublicOpenApiDocument } from '@/lib/api/public/openapi/emit';
import { PUBLIC_OPERATIONS } from '@/lib/api/public/openapi/operations';
import { publicOperationKey } from '@/lib/api/public/openapi/operation';

// The published public contract (MOTIR-3946) — the document itself.
//
// `tests/api/public/contract-drift.test.ts` is the half that compares the
// document to the ROUTES. This half asserts the document is well formed and
// says what the decision says it says.

type JsonObject = Record<string, unknown>;

describe('the public contract document', () => {
  const doc = emitPublicOpenApiDocument() as JsonObject;

  it('is OpenAPI 3.1 and carries the PUBLIC version, not v1’s', async () => {
    expect(doc['openapi']).toBe('3.1.0');
    const info = doc['info'] as JsonObject;
    expect(info['version']).toBe(PUBLIC_CONTRACT_VERSION);

    // The two contracts are separate objects with separate numbers. If these
    // ever coincide it must be a coincidence of value, never a shared import.
    const { V1_CONTRACT_VERSION } = await import('@/lib/api/v1/contractVersion');
    expect(PUBLIC_CONTRACT_VERSION).not.toBe(undefined);
    expect(typeof V1_CONTRACT_VERSION).toBe('string');
  });

  it('declares NO security scheme — the absence is the statement', () => {
    // OpenAPI reads a document with no `security` as "no authentication
    // required", which is the truth for every operation here. Copying v1's
    // bearer scheme and marking each operation `security: []` would describe a
    // credential this surface has no concept of.
    expect(doc['security']).toBeUndefined();
    expect((doc['components'] as JsonObject)['securitySchemes']).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('bearer');
  });

  it('hoists every named shape into `components.schemas`, and leaves no `$defs` pointer dangling', () => {
    // zod attaches a `.meta({ id })` subschema to the ROOT of ONE conversion as
    // `$defs`, so copying that root into a document leaves `#/$defs/X` pointing
    // at nothing — the failure the OpenAPI validator in `contract-route.test.ts`
    // caught before this document was ever served. The shapes move to
    // `components.schemas` and the pointers are rewritten to match.
    const schemas = (doc['components'] as JsonObject)['schemas'] as JsonObject;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    expect(JSON.stringify(doc)).not.toContain('#/$defs/');
    expect(JSON.stringify(doc['paths'])).not.toContain('"$defs"');

    // A shared shape is named ONCE, which is what the `.meta` id was asking for:
    // the overview references its stats block rather than inlining a copy.
    expect(Object.keys(schemas)).toContain('PublicProjectStats');
    expect(JSON.stringify(doc['paths'])).toContain('#/components/schemas/PublicProjectStats');
  });

  it('resolves every `$ref` it publishes — referential integrity, walked', () => {
    // The property a reader of the document actually depends on, and the reason
    // the hoist writes unconditionally rather than skipping a name it has seen:
    // what matters is that no pointer dangles, not which write put it there.
    const schemas = (doc['components'] as JsonObject)['schemas'] as JsonObject;
    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, member] of Object.entries(value as JsonObject)) {
          if (key === '$ref' && typeof member === 'string') refs.push(member);
          else walk(member);
        }
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `unresolvable pointer: ${ref}`).toMatch(/^#\/components\/schemas\//);
      expect(Object.keys(schemas), `unresolvable pointer: ${ref}`).toContain(
        ref.replace('#/components/schemas/', ''),
      );
    }
  });

  it('publishes no `id` keyword — the component KEY is the name, and `id` is not OpenAPI 3.1', () => {
    const schemas = (doc['components'] as JsonObject)['schemas'] as JsonObject;
    for (const [name, schema] of Object.entries(schemas)) {
      expect((schema as JsonObject)['id'], name).toBeUndefined();
    }
  });

  it('is byte-identical run to run — a consumer may cache it', () => {
    expect(JSON.stringify(emitPublicOpenApiDocument())).toBe(
      JSON.stringify(emitPublicOpenApiDocument()),
    );
  });

  it('emits every declared operation, and only those', () => {
    const paths = doc['paths'] as JsonObject;
    const emitted: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const method of Object.keys(item as JsonObject)) {
        emitted.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(emitted.sort()).toEqual(PUBLIC_OPERATIONS.map(publicOperationKey).sort());
  });

  it('gives every operation an operationId, a summary and its DECLARED success status', () => {
    // Not "a 200": two operations here are deliberately not 200 — a submitted
    // request answers 201 and an email subscribe answers 202 with no body — and
    // a test that demanded 200 would have forced the document to lie about
    // both (MOTIR-3990).
    const paths = doc['paths'] as JsonObject;
    for (const operation of PUBLIC_OPERATIONS) {
      const item = paths[operation.path] as JsonObject;
      const o = item[operation.method.toLowerCase()] as JsonObject;
      expect(o['operationId']).toBeTruthy();
      expect(o['summary']).toBeTruthy();
      const success = (o['responses'] as JsonObject)[String(operation.successStatus ?? 200)];
      expect(success, `${publicOperationKey(operation)} has no success response`).toBeTruthy();
      // A body-less success declares NO `content`, which is how OpenAPI says
      // "there is nothing to parse" — an empty schema would say the opposite.
      expect((success as JsonObject)['content'] === undefined).toBe(operation.response === null);
    }
  });

  it('declares a 401 on EVERY session-required operation, and on no other', () => {
    // The gatedness is the part a consumer meets first, and this surface's
    // session count was wrong three times before it was derived. The document
    // and the declarations agree here; `contract-coverage.test.ts` is what makes
    // the declarations agree with the ROUTES.
    const paths = doc['paths'] as JsonObject;
    for (const operation of PUBLIC_OPERATIONS) {
      const item = paths[operation.path] as JsonObject;
      const responses = (item[operation.method.toLowerCase()] as JsonObject)[
        'responses'
      ] as JsonObject;
      expect(
        responses['401'] !== undefined,
        `${publicOperationKey(operation)} declares 401: ${responses['401'] !== undefined}, sessionRequired: ${operation.sessionRequired === true}`,
      ).toBe(operation.sessionRequired === true);
    }
  });

  it('declares a request body on every operation that takes one, and marks the optional one optional', () => {
    const paths = doc['paths'] as JsonObject;
    for (const operation of PUBLIC_OPERATIONS) {
      const o = (paths[operation.path] as JsonObject)[operation.method.toLowerCase()] as JsonObject;
      const declared = o['requestBody'] as JsonObject | undefined;
      expect(declared !== undefined, publicOperationKey(operation)).toBe(
        operation.requestBody !== undefined,
      );
      if (operation.requestBody !== undefined && declared !== undefined) {
        // `POST …/follow` takes no body in its plain form; declaring it required
        // would document a 400 the route does not return.
        expect(declared['required']).toBe(operation.requestBody.required);
      }
    }
  });

  it('declares the 404 on the subject route — a failure a renderer must handle is contract, not omission', () => {
    const paths = doc['paths'] as JsonObject;
    const subject = (paths['/api/public/p/{identifier}'] as JsonObject)['get'] as JsonObject;
    expect((subject['responses'] as JsonObject)['404']).toBeTruthy();
  });

  it('has a unique operationId per operation — a generator names methods after them', () => {
    const ids = PUBLIC_OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
