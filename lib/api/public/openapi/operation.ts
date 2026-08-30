import type { z } from 'zod/v4';

// One PUBLIC operation, fully described (MOTIR-3946).
//
// ⚠️ THIS IS NOT `V1Operation`, AND THE DIFFERENCES ARE THE WHOLE POINT rather
// than an omission. That type requires `permission: PermissionKey` — v1's
// wrapper asserts one on every request — and its response body is a union over
// v1's `ListEnvelope` / `RankedListEnvelope`. Neither transfers:
//
//   * these routes carry no PERMISSION KEY. The eight anonymous ones have
//     nothing to declare; the four session-required ones (MOTIR-3990) are gated
//     on having an account at all, not on a permission — so inventing a key
//     would document a gate that does not exist;
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

/** A request body, for the four operations that take one. */
export interface PublicRequestBody {
  description: string;
  schema: z.ZodType;
  /** `false` for `POST …/follow`, whose bodiless form is the plain "follow". */
  required: boolean;
}

/** One published operation on the public surface. */
export interface PublicOperation {
  method: 'GET' | 'POST' | 'DELETE';
  /** The full served path template, in OpenAPI form. */
  path: string;
  /** A stable identifier a code generator names its method after. */
  operationId: string;
  summary: string;
  description: string;
  parameters: readonly PublicParameter[];
  /**
   * The success status. Omitted means 200 — the answer for every read.
   *
   * It is declared rather than assumed because two operations here are not 200
   * and a consumer that treats "not 200" as failure breaks on both: a submitted
   * request answers **201**, and an email subscribe answers **202 with no body
   * at all** (MOTIR-3990).
   */
  successStatus?: number;
  /**
   * The success body, or `null` for a status that carries none.
   *
   * `null` is a DECLARATION, not an omission: `POST …/subscribe` answers 202
   * empty whatever happened — already subscribed, newly subscribed,
   * unconfirmed-and-resent — because varying the answer would turn it into an
   * oracle for "does this address follow this project".
   */
  response: z.ZodType | null;
  /** The request body, for the writes. */
  requestBody?: PublicRequestBody;
  /**
   * Whether the operation REQUIRES the application's own browser session.
   *
   * ⚠️ FOUR OF THE TWELVE DO, and MOTIR-3946's first reading of this surface
   * said one — it counted `getSession()` and missed the two routes gated
   * through `requireCompliantSession`. The flag exists so the count is a
   * declared property a guard can check against the routes' own source
   * (`tests/api/public/contract-coverage.test.ts`) rather than a sentence in a
   * comment that was wrong three times.
   *
   * A session-required operation is NOT callable by a cross-origin consumer:
   * the session cookie is host-only on the application's origin
   * (`docs/decisions/public-surface-hosts.md` §4), so `motir.co` can read the
   * anonymous eight and cannot invoke these four. That is why the document
   * declares no security SCHEME — there is no credential a consumer of this
   * document can present — and declares the 401 instead.
   */
  sessionRequired?: boolean;
  /** Declared failures, in status order. */
  errors: readonly PublicErrorResponse[];
}

/** `GET /api/public/explore` → a stable key for drift comparison. */
export const publicOperationKey = (operation: PublicOperation): string =>
  `${operation.method} ${operation.path}`;
