import type { z } from 'zod/v4';

// One PUBLIC operation, fully described (MOTIR-3946).
//
// ⚠️ THIS IS NOT `V1Operation`, AND THE DIFFERENCES ARE THE WHOLE POINT rather
// than an omission. That type requires `permission: PermissionKey` — v1's
// wrapper asserts one on every request — and its response body is a union over
// v1's `ListEnvelope` / `RankedListEnvelope`. Neither transfers:
//
//   * these routes are ANONYMOUS by design, so there is no permission to
//     declare and inventing one would document a gate that does not exist;
//   * they return their DTO RAW, with no envelope, and `{ code }` on an error.
//
// What IS reused is everything that can be: the declaration DISCIPLINE (paths,
// parameters and schemas declared once, in a module beside the thing they
// describe, assembled by one registry) and `toOpenApiSchema` from v1's emitter,
// which is exported precisely so a second document does not need a second
// zod→OpenAPI conversion. One generator, one source of truth per surface.

/** Where a parameter travels. */
export type PublicParameterLocation = 'path' | 'query';

export interface PublicParameter {
  name: string;
  in: PublicParameterLocation;
  required: boolean;
  description: string;
  schema: z.ZodType;
}

/**
 * A non-200 response this operation can return.
 *
 * DECLARED rather than inferred, because the failures are part of the contract:
 * a consumer rendering a page needs to know that an unknown project is a 404
 * with a `code`, not an empty 200.
 */
export interface PublicErrorResponse {
  status: number;
  description: string;
  /** The body shape — every one of these routes answers `{ code }`. */
  schema: z.ZodType;
}

/** One published operation on the anonymous public read surface. */
export interface PublicOperation {
  method: 'GET' | 'POST' | 'DELETE';
  /** The full served path template, in OpenAPI form. */
  path: string;
  /** A stable identifier a code generator names its method after. */
  operationId: string;
  summary: string;
  description: string;
  parameters: readonly PublicParameter[];
  /** The 200 body. */
  response: z.ZodType;
  /** Declared failures, in status order. */
  errors: readonly PublicErrorResponse[];
}

/** `GET /api/public/explore` → a stable key for drift comparison. */
export const publicOperationKey = (operation: PublicOperation): string =>
  `${operation.method} ${operation.path}`;
