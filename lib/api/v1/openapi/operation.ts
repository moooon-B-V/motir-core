import type { z } from 'zod/v4';
import type { TokenScope } from '@/lib/mcp/scopes';
import type { V1ErrorStatus, V1SuccessStatus } from '@/lib/api/v1/openapi/statuses';

// The v1 OPERATION descriptor (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// Nothing in the repo said that `workItemDetailSchema` and
// `GET /api/v1/work-items/{key}` belong to the same operation: a person knew it,
// the code did not. This type is that missing value, and the registry that
// assembles it is what turns "the spec describes the API" from a claim a human
// maintains into a value the build can check.
//
// ── The totality discipline, copied from `lib/mcp/scopes.ts` ────────────────
// `scope`, `response` and `errorStatuses` are REQUIRED fields, so an operation
// that declares none of them is a COMPILE error rather than a review finding —
// the same guarantee `TOOL_SCOPES: Record<McpToolName, TokenScope>` gives the
// MCP surface. `tests/api/v1/openapi-registry.test.ts` pins that with
// `@ts-expect-error` assertions, so if a field ever became optional the
// now-unnecessary suppression fails `pnpm typecheck`.
//
// ── The scope here DOCUMENTS; the route ENFORCES ────────────────────────────
// ADR Amendment 4 Q2 pins the direction: `withV1Route({ scope })` stays the
// single enforcement point and this field is asserted EQUAL to it (Subtask
// 11.4.6's guard), never read at request time. Sourcing enforcement from a
// documentation artifact would turn a docs typo into a privilege bug, and would
// delete the independent second opinion the drift guard exists to be.

/** The HTTP verbs a v1 operation can use. */
export const V1_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

/** One HTTP verb. */
export type V1Method = (typeof V1_METHODS)[number];

/** Where a parameter rides. */
export type V1ParameterLocation = 'path' | 'query' | 'header';

/** One declared request parameter. */
export interface V1Parameter {
  name: string;
  in: V1ParameterLocation;
  required: boolean;
  description: string;
  schema: z.ZodType;
  /**
   * How an ARRAY-valued parameter spreads across the query string.
   *
   * `true` is `?kind=a&kind=b` — one repeated key, which is what
   * `URLSearchParams.getAll` reads and therefore the only form our routes
   * accept. It is also OpenAPI 3.1's default for a `form`-style query
   * parameter, so emitting it changes no reader's interpretation; it is written
   * down because a wire form the server cannot parse if it changed is not
   * something to leave resting on a default (MOTIR-2317).
   *
   * Omit on a scalar, where it has no meaning.
   */
  explode?: boolean;
}

/**
 * The BODY an operation returns, as a discriminated union.
 *
 * Modelled as a union rather than a bare schema so "which envelope does this
 * collection return?" is a DECLARED property the emitter and the drift guard
 * can both read. ADR Amendment 3 Q2 requires each collection operation to
 * reference the one its route actually returns, and a free-form schema would
 * make that unanswerable without re-deriving it from the shape.
 */
export type V1ResponseBody =
  /** A single resource. */
  | { kind: 'object'; schema: z.ZodType }
  /** A cursor page — the PLAIN envelope, no `totalCount`. */
  | { kind: 'page'; item: z.ZodType }
  /**
   * A ranked collection page — the envelope carrying `totalCount`.
   *
   * `extend` adds fields BESIDE the envelope's, for a page that answers
   * something the envelope cannot express. It exists for exactly one shape
   * today: the activity `all` view merges two streams and reports each one's
   * total separately, which a single `totalCount` cannot carry (ADR Amendment
   * 12). Reaching for it is a signal to check whether the envelope is really
   * the wrong shape — extending is right when the extra field is a property of
   * THIS read, and wrong when it is a property of paging.
   */
  | { kind: 'rankedPage'; item: z.ZodType; extend?: z.ZodType }
  /** No body at all (a 204). */
  | { kind: 'empty' };

/** One `/api/v1` operation, fully described. */
export interface V1Operation {
  /** The HTTP verb. */
  method: V1Method;
  /**
   * The path TEMPLATE, in OpenAPI form — `/api/v1/work-items/{key}`.
   *
   * The full served path, not a suffix: it is what a client calls and what the
   * drift guard (Subtask 11.4.6) matches against the route tree.
   */
  path: string;
  /** A stable identifier a code generator names its method after. */
  operationId: string;
  /** One line, for the reference page's operation list. */
  summary: string;
  /** The longer prose, for the operation's own section. */
  description: string;
  /** The scope the ROUTE requires. Documented here, enforced there. */
  scope: TokenScope;
  /** Path, query and request-header parameters. */
  parameters: readonly V1Parameter[];
  /** The request body, for the verbs that take one. */
  requestBody?: { schema: z.ZodType; description: string };
  /** The success status and what it carries. */
  response: { status: V1SuccessStatus; body: V1ResponseBody; description: string };
  /**
   * The error statuses this operation can actually produce.
   *
   * Declared per operation rather than emitted wholesale, because "every
   * endpoint can return every error" is false and a reference that says so
   * teaches a client to handle cases it will never see. 401/403/429/500 come
   * from the wrapper and ride every operation (the emitter adds them); this list
   * is what the operation ITSELF can raise.
   */
  errorStatuses: readonly V1ErrorStatus[];
}

/** The registry key: the verb and the path, the pair that names an operation. */
export function operationKey(operation: Pick<V1Operation, 'method' | 'path'>): string {
  return `${operation.method} ${operation.path}`;
}

/**
 * Declare an operation.
 *
 * An identity function whose only job is to apply {@link V1Operation}'s type at
 * the declaration site — so a missing `scope`, a missing `response` or a status
 * outside the vocabulary fails where it is written rather than where it is
 * assembled. The same reason `lib/mcp/scopes.ts` annotates its map instead of
 * letting inference widen it.
 */
export function defineOperation(operation: V1Operation): V1Operation {
  return operation;
}

/**
 * The wrapper's own error statuses, on EVERY operation.
 *
 * 401 (no/!valid token), 403 (valid token, wrong scope), 429 (budget spent) and
 * 500 (an unrecognised fault) are raised by `withV1Route` before or around the
 * handler, so no operation can avoid them and none needs to declare them.
 */
export const V1_WRAPPER_ERROR_STATUSES: readonly V1ErrorStatus[] = [401, 403, 429, 500];
