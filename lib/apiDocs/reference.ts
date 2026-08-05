import { z } from 'zod/v4';
import { toOpenApiSchema, V1_CONTRACT_VERSION } from '@/lib/api/v1/openapi/emit';
import {
  V1_WRAPPER_ERROR_STATUSES,
  type V1Operation,
  type V1Parameter,
} from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';
import { V1_STATUS_DESCRIPTIONS, type V1Status } from '@/lib/api/v1/openapi/statuses';

// The API-REFERENCE view model (Story 11.4 · Subtask 11.4.7 — MOTIR-2188).
//
// ── Read from the EMITTER, never over HTTP ──────────────────────────────────
// The page and `/api/openapi/v1.json` have ONE source: Subtask 11.4.4's
// operation registry. A page that fetched its own public URL would add a network
// round trip, a failure mode and a bootstrapping problem for no gain — the card
// says so, and it is also why the "spec unavailable" state below is about the
// EMITTER throwing rather than about a fetch failing.
//
// This module is pure: registry in, plain data out. That is what lets the whole
// reference be asserted against the registry (an operation added later cannot go
// unrendered) without mounting a page.

/** The example host the `curl` samples use when the deployment names none. */
const EXAMPLE_ORIGIN = 'https://app.motir.co';

/**
 * The bearer PLACEHOLDER, not a plausible-looking fake.
 *
 * A realistic-looking token in published documentation gets pasted verbatim and
 * then debugged as an auth problem; an obvious placeholder cannot.
 */
export const EXAMPLE_TOKEN = 'motir_pat_<your-token>';

/** One row of the parameter table. */
export interface ReferenceParameter {
  name: string;
  location: V1Parameter['in'];
  required: boolean;
  description: string;
  /** The JSON-Schema `type` (or `enum`) a reader needs, not the whole schema. */
  type: string;
}

/** One row of the response table. */
export interface ReferenceResponse {
  status: V1Status;
  description: string;
  /** `true` for the operation's own success row. */
  success: boolean;
}

/** One operation, as the reference renders it. */
export interface ReferenceOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  scope: string;
  parameters: ReferenceParameter[];
  /** The request body's JSON schema, pretty-printed — absent when it takes none. */
  requestBody?: string;
  /** The response body's JSON schema, pretty-printed — absent for a 204. */
  responseBody?: string;
  /** Which page envelope wraps the rows, when the operation returns a page. */
  envelope?: 'page' | 'rankedPage';
  responses: ReferenceResponse[];
  /** The copy-pasteable authenticated example. */
  example: string;
}

/** Operations grouped by the resource whose module declares them. */
export interface ReferenceGroup {
  key: string;
  label: string;
  operations: ReferenceOperation[];
}

/** Everything the reference page renders. */
export interface ApiReference {
  contractVersion: string;
  specPath: string;
  groups: ReferenceGroup[];
  operationCount: number;
}

/** Where the served document lives — ADR Amendment 4 Q3. */
export const SPEC_PATH = '/api/openapi/v1.json';

/**
 * The resource a path belongs to, and the order the groups read in.
 *
 * Derived from the path rather than declared per operation: the path IS the
 * resource on a REST surface, so a second declaration would be a second thing to
 * keep in step with the first. A path matching nothing falls into `Other`, which
 * is visible rather than silent — a new resource shows up unlabelled instead of
 * disappearing.
 */
const GROUPS: readonly { key: string; label: string; test: (path: string) => boolean }[] = [
  { key: 'identity', label: 'Identity', test: (p) => p === '/api/v1/me' },
  { key: 'workspaces', label: 'Workspaces', test: (p) => p.startsWith('/api/v1/workspaces') },
  {
    key: 'work-items',
    label: 'Work items',
    test: (p) => p.startsWith('/api/v1/work-items') || p.endsWith('/work-items'),
  },
  { key: 'sprints', label: 'Sprints', test: (p) => p.startsWith('/api/v1/sprints') },
  {
    key: 'planning',
    label: 'Projects, backlog & ready',
    test: (p) => p.startsWith('/api/v1/projects'),
  },
];

function groupFor(path: string): { key: string; label: string } {
  const match = GROUPS.find((group) => group.test(path));
  return match ? { key: match.key, label: match.label } : { key: 'other', label: 'Other' };
}

/**
 * A short, READABLE type for a parameter — `string`, `integer`, `"asc" | "desc"`.
 *
 * The full JSON Schema is right for the machine document and wrong for a table
 * cell: a reader scanning fifteen parameters needs the shape, not its
 * constraints. The constraints stay in the description, where they were written.
 */
export function describeParameterType(schema: z.ZodType): string {
  const json = toOpenApiSchema(schema, 'input') as {
    type?: string;
    enum?: unknown[];
    anyOf?: { type?: string }[];
  };
  if (Array.isArray(json.enum)) {
    return json.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  if (typeof json.type === 'string') return json.type;
  if (Array.isArray(json.anyOf)) {
    return json.anyOf.map((branch) => branch.type ?? 'unknown').join(' | ');
  }
  return 'unknown';
}

/** A schema as pretty JSON, for the body panels. */
function prettySchema(schema: z.ZodType, io: 'input' | 'output'): string {
  return JSON.stringify(toOpenApiSchema(schema, io), null, 2);
}

/**
 * A path template with its parameters filled in by EXAMPLE values, so the
 * `curl` can actually be pasted.
 *
 * `{key}` becomes a real-looking work-item key rather than staying a brace — a
 * sample a reader must edit before it runs is a sample they will get wrong once.
 */
function examplePath(operation: V1Operation): string {
  return operation.path
    .replace('{key}', 'MOTIR-1854')
    .replace('{projectKey}', 'MOTIR')
    .replace('{sprintId}', 'spr_01hxyz');
}

/**
 * A minimal example BODY for an operation that takes one.
 *
 * Only the REQUIRED properties: an example carrying every optional field teaches
 * a reader that they are all required, which is the opposite of what the schema
 * says. `undefined` when the schema has no required properties — an empty `{}`
 * body is legal for the lifecycle POSTs and is what the sample sends.
 */
function exampleBody(schema: z.ZodType): string {
  const json = toOpenApiSchema(schema, 'input') as {
    properties?: Record<string, { type?: string; enum?: unknown[]; items?: unknown }>;
    required?: string[];
  };
  const required = json.required ?? [];
  if (required.length === 0) return '{}';

  const sample: Record<string, unknown> = {};
  for (const name of required) {
    const property = json.properties?.[name];
    if (property?.enum?.length) sample[name] = property.enum[0];
    else if (property?.type === 'array') sample[name] = ['MOTIR-1854'];
    else if (property?.type === 'number' || property?.type === 'integer') sample[name] = 1;
    else if (property?.type === 'boolean') sample[name] = true;
    else sample[name] = `<${name}>`;
  }
  return JSON.stringify(sample);
}

/**
 * The copy-pasteable authenticated example for one operation.
 *
 * Correct for THAT operation's method, path and body — the acceptance criterion
 * is specific about this, because a reference whose samples are all
 * `curl <base>/<path>` teaches nothing a reader could not have guessed.
 */
export function buildExample(operation: V1Operation, origin: string = EXAMPLE_ORIGIN): string {
  const url = `${origin}${examplePath(operation)}`;
  const query = operation.parameters.filter((p) => p.in === 'query' && p.required);
  const suffix = query.length ? `?${query.map((p) => `${p.name}=<${p.name}>`).join('&')}` : '';
  // Quote the URL only when it carries a query string — an unquoted `&` is the
  // commonest way a pasted sample silently backgrounds itself in a shell.
  const target = suffix ? `"${url}${suffix}"` : url;

  const lines: string[] = [];
  lines.push(
    operation.method === 'GET' ? `curl ${target} \\` : `curl -X ${operation.method} ${target} \\`,
  );
  lines.push(`  -H "Authorization: Bearer ${EXAMPLE_TOKEN}"`);

  if (operation.requestBody) {
    lines[lines.length - 1] += ' \\';
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${exampleBody(operation.requestBody.schema)}'`);
  }
  return lines.join('\n');
}

/** One operation's response rows: its own success, then every error it can raise. */
function responsesFor(operation: V1Operation): ReferenceResponse[] {
  const statuses = [...new Set([...operation.errorStatuses, ...V1_WRAPPER_ERROR_STATUSES])].sort(
    (a, b) => a - b,
  );
  return [
    {
      status: operation.response.status,
      description: operation.response.description,
      success: true,
    },
    ...statuses.map((status) => ({
      status,
      description: V1_STATUS_DESCRIPTIONS[status],
      success: false,
    })),
  ];
}

/** One operation, as the reference renders it. */
export function toReferenceOperation(operation: V1Operation, origin?: string): ReferenceOperation {
  const body = operation.response.body;
  return {
    id: operation.operationId,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description,
    scope: operation.scope,
    parameters: operation.parameters.map((parameter) => ({
      name: parameter.name,
      location: parameter.in,
      required: parameter.required,
      description: parameter.description,
      type: describeParameterType(parameter.schema),
    })),
    ...(operation.requestBody
      ? { requestBody: prettySchema(operation.requestBody.schema, 'input') }
      : {}),
    ...(body.kind === 'object' ? { responseBody: prettySchema(body.schema, 'output') } : {}),
    ...(body.kind === 'page' || body.kind === 'rankedPage'
      ? { envelope: body.kind, responseBody: prettySchema(body.item, 'output') }
      : {}),
    responses: responsesFor(operation),
    example: buildExample(operation, origin),
  };
}

/**
 * The whole reference, grouped and ordered.
 *
 * Built from `V1_OPERATIONS` directly, so "does the page show every operation?"
 * is answerable by comparing two arrays rather than by rendering and counting.
 */
export function buildApiReference(origin?: string): ApiReference {
  const groups: ReferenceGroup[] = [];
  for (const operation of V1_OPERATIONS) {
    const { key, label } = groupFor(operation.path);
    const existing = groups.find((group) => group.key === key);
    const rendered = toReferenceOperation(operation, origin);
    if (existing) existing.operations.push(rendered);
    else groups.push({ key, label, operations: [rendered] });
  }
  // Group ORDER follows the declared order above, not first-seen order, so the
  // catalogue reads the same whichever module happens to be first in the registry.
  const rank = (key: string) => {
    const index = GROUPS.findIndex((group) => group.key === key);
    return index === -1 ? GROUPS.length : index;
  };
  groups.sort((a, b) => rank(a.key) - rank(b.key));

  return {
    contractVersion: V1_CONTRACT_VERSION,
    specPath: SPEC_PATH,
    groups,
    operationCount: groups.reduce((total, group) => total + group.operations.length, 0),
  };
}
