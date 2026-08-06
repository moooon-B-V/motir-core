import { z } from 'zod/v4';
import {
  V1_PAGE_ENVELOPE_COMPONENT,
  V1_RANKED_PAGE_ENVELOPE_COMPONENT,
  v1PageEnvelopeSchema,
  v1RankedPageEnvelopeSchema,
} from '@/lib/api/v1/openapi/envelopes';
import {
  V1_ERROR_BODY_COMPONENT,
  V1_INTERNAL_ERROR_BODY_COMPONENT,
  v1ErrorBodySchema,
  v1InternalErrorBodySchema,
} from '@/lib/api/v1/openapi/errorResponse';
import { V1_SHARED_RESPONSE_HEADERS } from '@/lib/api/v1/openapi/headers';
import {
  V1_WRAPPER_ERROR_STATUSES,
  type V1Operation,
  type V1Parameter,
  type V1ResponseBody,
} from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS, V1_RESOURCE_COMPONENTS } from '@/lib/api/v1/openapi/registry';
import {
  V1_SCOPE_EXTENSION,
  V1_SECURITY_SCHEME_NAME,
  v1SecurityScheme,
} from '@/lib/api/v1/openapi/security';
import { V1_STATUS_DESCRIPTIONS, type V1ErrorStatus } from '@/lib/api/v1/openapi/statuses';

// The OpenAPI 3.1 EMITTER (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// Assembles the document from the operation registry and the `zod` schemas the
// routes already return. Nothing here is authored twice: a shape appears in this
// file only as a reference to the schema that shapes the real response, which is
// the property that makes "the spec is wrong" a test failure rather than a
// discovery by a client.
//
// ── Why `zod/v4`'s own emitter ──────────────────────────────────────────────
// ADR Amendment 4 Q1. `z.toJSONSchema()` emits JSON Schema 2020-12, which IS
// OpenAPI 3.1's schema dialect — so there is no down-conversion step and no
// third-party emitter tracking a schema library we already carry the successor
// of. `reused: 'inline'` keeps zod from minting its own `$defs`: this module owns
// `components/schemas`, and two competing definition sections in one document is
// exactly the second-artifact problem in miniature.
//
// ── ONE DOCUMENT PER API MAJOR ──────────────────────────────────────────────
// The emitter takes the major version as an argument, and there being exactly
// one today is the degenerate case rather than the model (ADR Amendment 4 Q6).
// `v2` becomes a SECOND document beside the first, never an edit of it — which
// is the only shape under which §8's "keep the old behaviour working for the
// announced window" is an artifact rather than a promise.

/** The API majors this repo can emit a document for. */
export const V1_API_MAJOR = 1;

/**
 * `info.version` — the API CONTRACT's version, NOT the app's release number.
 *
 * MAJOR is the path version (`1`), MINOR increments on an additive change under
 * ADR §8's allowed list, and PATCH on a documentation-only correction. A client
 * reading it learns what the contract offers; a release number would churn on
 * every unrelated deploy and tell a client nothing it can act on. This is the
 * number Story 11.5's CLI version-skew gate compares against.
 */
export const V1_CONTRACT_VERSION = '1.1.0';

/** A JSON value, as the emitted document is made of. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object, the shape most of the document is. */
type JsonObject = { [key: string]: Json };

/**
 * Convert one `zod` schema to its OpenAPI 3.1 schema object.
 *
 * `io: 'output'` because a response schema describes what the server SENDS: an
 * input-side conversion would document defaults and coercions the client never
 * sees. `$schema` is stripped — legal inside a 3.1 component, but noise that no
 * reader or generator needs repeated on every shape.
 */
export function toOpenApiSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonObject {
  const emitted = z.toJSONSchema(schema, { io, reused: 'inline' }) as JsonObject;
  const { $schema: _discarded, ...rest } = emitted;
  return rest;
}

/** A `$ref` to a named component schema. */
function schemaRef(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * The component name a resource schema is registered under, if it is registered
 * — so an operation `$ref`s the shared definition instead of inlining a copy.
 */
function componentNameFor(schema: z.ZodType): string | undefined {
  for (const [name, registered] of Object.entries(V1_RESOURCE_COMPONENTS)) {
    if (registered === schema) return name;
  }
  return undefined;
}

/** A schema object for a response/request body: a `$ref` when we have one. */
function bodySchema(schema: z.ZodType): JsonObject {
  const name = componentNameFor(schema);
  return name ? schemaRef(name) : toOpenApiSchema(schema);
}

/**
 * The response body schema for an operation, composing the ENVELOPE its route
 * actually returns with that route's item shape.
 *
 * The `allOf` is the standard OpenAPI form for a generic envelope — OpenAPI has
 * no generics — and it is deliberately a `$ref` to the named envelope plus a
 * narrowing of `items`, rather than an inlined flat object. That way the
 * document literally CONTAINS the reference ADR Amendment 3 Q2 requires ("each
 * operation references the one its route returns"), so Subtask 11.4.6 can assert
 * it instead of re-deriving which envelope was meant from the emitted shape.
 */
function responseBodySchema(body: V1ResponseBody): JsonObject | undefined {
  switch (body.kind) {
    case 'empty':
      return undefined;
    case 'object':
      return bodySchema(body.schema);
    case 'page':
      return {
        allOf: [
          schemaRef(V1_PAGE_ENVELOPE_COMPONENT),
          {
            type: 'object',
            properties: { items: { type: 'array', items: bodySchema(body.item) } },
          },
        ],
      };
    case 'rankedPage':
      return {
        allOf: [
          schemaRef(V1_RANKED_PAGE_ENVELOPE_COMPONENT),
          {
            type: 'object',
            properties: { items: { type: 'array', items: bodySchema(body.item) } },
          },
        ],
      };
  }
}

/** The shared response headers, as a 3.1 `headers` object. */
function sharedResponseHeaders(): JsonObject {
  const headers: JsonObject = {};
  for (const header of V1_SHARED_RESPONSE_HEADERS) {
    headers[header.name] = {
      description: header.description,
      schema: toOpenApiSchema(header.schema),
    };
  }
  return headers;
}

/** One declared parameter, as a 3.1 parameter object. */
function parameterObject(parameter: V1Parameter): JsonObject {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    description: parameter.description,
    schema: toOpenApiSchema(parameter.schema, 'input'),
  };
}

/** One error status, as a 3.1 response object. */
function errorResponse(status: V1ErrorStatus): JsonObject {
  // 500 is the one failure with no `code`: an unexpected fault has no stable
  // contract, so it gets the other body (ADR §4).
  const schema = schemaRef(
    status === 500 ? V1_INTERNAL_ERROR_BODY_COMPONENT : V1_ERROR_BODY_COMPONENT,
  );
  return {
    description: V1_STATUS_DESCRIPTIONS[status],
    headers: sharedResponseHeaders(),
    content: { 'application/json': { schema } },
  };
}

/** Every response an operation can produce — its own, plus the wrapper's. */
function responsesFor(operation: V1Operation): JsonObject {
  const responses: JsonObject = {};

  const successBody = responseBodySchema(operation.response.body);
  responses[String(operation.response.status)] = {
    description: operation.response.description,
    headers: sharedResponseHeaders(),
    ...(successBody ? { content: { 'application/json': { schema: successBody } } } : {}),
  };

  // The union of what the operation itself raises and what the wrapper raises
  // around it, de-duplicated and ordered so the document is stable across runs.
  const statuses = [...new Set([...operation.errorStatuses, ...V1_WRAPPER_ERROR_STATUSES])].sort(
    (a, b) => a - b,
  );
  for (const status of statuses) {
    responses[String(status)] = errorResponse(status);
  }
  return responses;
}

/** One operation, as a 3.1 operation object. */
function operationObject(operation: V1Operation): JsonObject {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.description}\n\nRequires the \`${operation.scope}\` scope.`,
    // The scope as an EXTENSION: `type: http` bearer has no `scopes` map, and
    // inventing an `oauth2` scheme to get one would document a flow this API
    // does not implement (ADR Amendment 4 Q2/Q4).
    [V1_SCOPE_EXTENSION]: operation.scope,
    ...(operation.parameters.length > 0
      ? { parameters: operation.parameters.map(parameterObject) }
      : {}),
    ...(operation.requestBody
      ? {
          requestBody: {
            required: true,
            description: operation.requestBody.description,
            content: {
              'application/json': {
                schema: toOpenApiSchema(operation.requestBody.schema, 'input'),
              },
            },
          },
        }
      : {}),
    responses: responsesFor(operation),
    security: [{ [V1_SECURITY_SCHEME_NAME]: [] }],
  };
}

/** The shared components every operation composes. */
function sharedComponentSchemas(): JsonObject {
  return {
    [V1_ERROR_BODY_COMPONENT]: toOpenApiSchema(v1ErrorBodySchema),
    [V1_INTERNAL_ERROR_BODY_COMPONENT]: toOpenApiSchema(v1InternalErrorBodySchema),
    // The two envelopes, emitted with an UNCONSTRAINED `items` so an operation
    // can narrow it in its `allOf`. They are the reusable half of the shape; the
    // row type is the operation's.
    [V1_PAGE_ENVELOPE_COMPONENT]: toOpenApiSchema(v1PageEnvelopeSchema(z.unknown())),
    [V1_RANKED_PAGE_ENVELOPE_COMPONENT]: toOpenApiSchema(v1RankedPageEnvelopeSchema(z.unknown())),
  };
}

/** Options the emitted document's `info` and `servers` blocks are built from. */
export interface EmitOptions {
  /** The API MAJOR this document describes. One document per major. */
  major?: number;
  /** `info.version` — the contract's version, not the app's release. */
  contractVersion?: string;
  /** The base URL to advertise, when the deployment knows its own. */
  serverUrl?: string;
}

/**
 * Emit the OpenAPI 3.1 document for one API major.
 *
 * Deterministic: given the same registry it produces the same document, byte
 * for byte, so a diff on the emitted spec is a diff on the API rather than on
 * the emitter's mood. That is what lets Subtask 11.4.6 assert against it and
 * what lets a client generator cache it.
 */
export function emitOpenApiDocument(options: EmitOptions = {}): JsonObject {
  const major = options.major ?? V1_API_MAJOR;
  const contractVersion = options.contractVersion ?? V1_CONTRACT_VERSION;

  const paths: JsonObject = {};
  for (const operation of V1_OPERATIONS) {
    // A document is per MAJOR, so an operation outside this one's path prefix
    // belongs to a different document, not to a filtered corner of this one.
    if (!operation.path.startsWith(`/api/v${major}/`)) continue;
    const existing = (paths[operation.path] as JsonObject | undefined) ?? {};
    paths[operation.path] = {
      ...existing,
      [operation.method.toLowerCase()]: operationObject(operation),
    };
  }

  const resourceComponents: JsonObject = {};
  for (const [name, schema] of Object.entries(V1_RESOURCE_COMPONENTS)) {
    resourceComponents[name] = toOpenApiSchema(schema);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Motir API',
      version: contractVersion,
      summary: `The Motir public REST API, v${major}.`,
      description:
        'The versioned integration surface every Motir client shares. Authenticate with a personal access token as `Authorization: Bearer motir_pat_…`. Within a major version this contract is additive-only: fields and endpoints may be ADDED without notice, and nothing is removed, renamed or re-typed. Clients MUST therefore tolerate unknown fields and unknown enum values, and MUST NOT parse the human `error` sentence — only the machine `code`.',
      license: { name: 'GPL-3.0', identifier: 'GPL-3.0-only' },
    },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
    paths,
    components: {
      schemas: { ...sharedComponentSchemas(), ...resourceComponents },
      securitySchemes: { [V1_SECURITY_SCHEME_NAME]: { ...v1SecurityScheme } },
    },
    security: [{ [V1_SECURITY_SCHEME_NAME]: [] }],
  };
}
